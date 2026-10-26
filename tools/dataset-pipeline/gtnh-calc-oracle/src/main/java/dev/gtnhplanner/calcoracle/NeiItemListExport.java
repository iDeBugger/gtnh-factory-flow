package dev.gtnhplanner.calcoracle;

import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraft.nbt.NBTTagCompound;
import net.minecraft.nbt.NBTTagList;
import net.minecraftforge.fluids.FluidStack;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * NEI's item list in NEI's own order: every stack the panel lists, sorted by the pack's
 * {@code inventory.itemsort}, as one resource key per stack ({@code item:<id>[@meta]},
 * {@code fluid:<name>}, {@code aspect:thaumcraft:aspect:<tag>}). The website sorts its item
 * list by this ("As in NEI").
 *
 * <p>NEI builds the list only once a world loads, and the oracle exports from the main menu, so
 * this does what that load does, with NEI's own code wherever NEI has it: it boots NEI's item
 * info and plugins (they hide items, add variants and fill the item owners the "mod" rule reads)
 * and waits for the plugin thread; it collects each registry item's stacks through NEI's own
 * {@code getPermutations}, numbers them in registry order into {@code ItemSorter}'s "default"
 * ordering, drops duplicates through NEI's {@code ItemStackSet}, and sorts with
 * {@code ItemSorter.sort}. Collapsible groups are not applied: a group sits where its first
 * stack sits, so the order of stacks is the same.
 *
 * <p>Per pack: 2.9's NEI (2.8.155-GTNH) keeps {@code getPermutations} static on
 * {@code ItemListLoader} and lists fluids as {@code neiFluidDisplay} stacks
 * ({@code StackInfo.isFluidDisplayItem}); 2.8.1's (2.8.19-GTNH) keeps it as an instance method
 * of the {@code ItemList.loadItems} task and lists no fluids. Everything is reflection: the
 * exporter compiles against no NEI. A failure leaves {@code status: "failed"} and the reason,
 * never the rest of the export; the pipeline then sorts by its approximation.
 */
final class NeiItemListExport {

    private static final long BOOT_TIMEOUT_MS =
        Long.getLong("gtnh.oracle.neiBootTimeoutSeconds", 900L).longValue() * 1000L;

    private final GtnhCalcOracleExporter exporter;

    NeiItemListExport(GtnhCalcOracleExporter exporter) {
        this.exporter = exporter;
    }

    Map<String, Object> export(List<Map<String, Object>> adapters) {
        long started = System.currentTimeMillis();
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        Class<?> config;
        try {
            config = Class.forName("codechicken.nei.NEIClientConfig");
        } catch (Throwable t) {
            out.put("status", "not_present");
            adapters.add(exporter.adapter("nei-item-list", "not_present", false, 0, 0, started, null));
            return out;
        }
        try {
            bootNei(config);
            List<ItemStack> items = gatherItems();
            Class<?> sorter = Class.forName("codechicken.nei.ItemSorter");
            sorter.getMethod("sort", List.class).invoke(null, items);
            Object sortList = sorter.getField("list").get(null);
            String sortString = String.valueOf(sorter.getMethod("getSaveString", List.class).invoke(null, sortList));

            Method isFluidDisplay = staticMethod("codechicken.nei.recipe.StackInfo", "isFluidDisplayItem", ItemStack.class);
            Method getFluid = staticMethod("codechicken.nei.recipe.StackInfo", "getFluid", ItemStack.class);
            List<String> keys = new ArrayList<String>(items.size());
            int unnamed = 0;
            for (ItemStack stack : items) {
                String key = resourceKey(stack, isFluidDisplay, getFluid);
                if (key == null) {
                    unnamed++;
                }
                keys.add(key);
            }

            out.put("status", "exported");
            out.put("sort", sortString);
            out.put("stackCount", Integer.valueOf(keys.size()));
            out.put("stacks", keys);
            GtnhCalcOracleMod.LOG.info(
                "GTNH calculation oracle NEI item list: {} stack(s), sorted by {}.",
                Integer.valueOf(keys.size()),
                sortString
            );
            adapters.add(exporter.adapter(
                "nei-item-list",
                "exported",
                true,
                keys.size(),
                0,
                started,
                unnamed > 0 ? unnamed + " stack(s) with no resource key" : null
            ));
        } catch (Throwable t) {
            Throwable cause = t.getCause() != null ? t.getCause() : t;
            GtnhCalcOracleMod.LOG.error("GTNH calculation oracle NEI item list failed.", cause);
            out.clear();
            out.put("status", "failed");
            out.put("error", String.valueOf(cause));
            adapters.add(exporter.adapter("nei-item-list", "failed", true, 0, 0, started, String.valueOf(cause)));
        }
        return out;
    }

    /** NEI's boot as a world load runs it, then the plugin thread's end (it sets pluginNEIConfigLoaded last). */
    private void bootNei(Class<?> config) throws Exception {
        Field main = config.getDeclaredField("mainNEIConfigLoaded");
        Field plugins = config.getDeclaredField("pluginNEIConfigLoaded");
        main.setAccessible(true);
        plugins.setAccessible(true);
        if (plugins.getBoolean(null)) {
            return;
        }
        if (!main.getBoolean(null)) {
            config.getMethod("bootNEI").invoke(null);
        }
        long deadline = System.currentTimeMillis() + BOOT_TIMEOUT_MS;
        while (!plugins.getBoolean(null)) {
            if (System.currentTimeMillis() > deadline) {
                throw new IllegalStateException("NEI plugins did not finish loading in " + BOOT_TIMEOUT_MS / 1000 + " s");
            }
            Thread.sleep(250L);
        }
    }

    /**
     * NEI's gatherItems: each registry item's permutations, numbered in registry order into
     * ItemSorter's ordering (the "default" rule), duplicates dropped by ItemStackSet. An item
     * whose permutations throw is left out, as NEI removes it.
     */
    @SuppressWarnings("unchecked")
    private List<ItemStack> gatherItems() throws Exception {
        Permutations permutations = permutations();
        Class<?> sorterClass = Class.forName("codechicken.nei.ItemSorter");
        Object sorter = sorterClass.getField("instance").get(null);
        Map<ItemStack, Integer> ordering = (Map<ItemStack, Integer>) sorterClass.getField("ordering").get(sorter);
        ordering.clear();

        Class<?> setClass = Class.forName("codechicken.nei.ItemStackSet");
        Object unique = setClass.getConstructor().newInstance();
        Method contains = setClass.getMethod("contains", ItemStack.class);
        Method add = setClass.getMethod("add", ItemStack.class);

        List<ItemStack> items = new ArrayList<ItemStack>();
        int index = 0;
        int failed = 0;
        for (Item item : (Iterable<Item>) Item.itemRegistry) {
            if (item == null || item.delegate == null || item.delegate.name() == null) {
                continue;
            }
            List<ItemStack> stacks;
            try {
                stacks = permutations.of(item);
            } catch (Throwable t) {
                failed++;
                continue;
            }
            for (ItemStack stack : stacks) {
                ordering.put(stack, Integer.valueOf(index++));
                if (!((Boolean) contains.invoke(unique, stack)).booleanValue()) {
                    add.invoke(unique, stack);
                    items.add(stack);
                }
            }
        }
        if (failed > 0) {
            GtnhCalcOracleMod.LOG.warn("GTNH calculation oracle NEI item list left out {} item(s) whose stacks threw.", Integer.valueOf(failed));
        }
        return items;
    }

    private interface Permutations {
        List<ItemStack> of(Item item) throws Exception;
    }

    /** NEI's own getPermutations: static on ItemListLoader (2.9), on the loadItems task (2.8.1). */
    private Permutations permutations() throws Exception {
        try {
            final Method method = Class.forName("codechicken.nei.ItemListLoader").getDeclaredMethod("getPermutations", Item.class);
            method.setAccessible(true);
            return new Permutations() {
                @SuppressWarnings("unchecked")
                @Override
                public List<ItemStack> of(Item item) throws Exception {
                    return (List<ItemStack>) method.invoke(null, item);
                }
            };
        } catch (ClassNotFoundException absent) {
            final Object task = Class.forName("codechicken.nei.ItemList").getField("loadItems").get(null);
            final Method method = task.getClass().getDeclaredMethod("getPermutations", Item.class);
            method.setAccessible(true);
            return new Permutations() {
                @SuppressWarnings("unchecked")
                @Override
                public List<ItemStack> of(Item item) throws Exception {
                    return (List<ItemStack>) method.invoke(task, item);
                }
            };
        }
    }

    /** The dataset's key for a listed stack: a fluid display is its fluid, an aspect item its aspect. */
    private String resourceKey(ItemStack stack, Method isFluidDisplay, Method getFluid) {
        if (stack == null || stack.getItem() == null) {
            return null;
        }
        String registryId = String.valueOf(Item.itemRegistry.getNameForObject(stack.getItem()));
        if (registryId.length() == 0 || "null".equals(registryId)) {
            return null;
        }
        String fluid = fluidName(stack, isFluidDisplay, getFluid);
        if (fluid != null) {
            return "fluid:" + fluid;
        }
        String aspect = aspectTag(stack, registryId);
        if (aspect != null) {
            return "aspect:thaumcraft:aspect:" + aspect.toLowerCase(Locale.ROOT);
        }
        return "item:" + exporter.itemResourceId(registryId, stack.getItemDamage());
    }

    private static String fluidName(ItemStack stack, Method isFluidDisplay, Method getFluid) {
        if (isFluidDisplay == null || getFluid == null) {
            return null;
        }
        try {
            if (!((Boolean) isFluidDisplay.invoke(null, stack)).booleanValue()) {
                return null;
            }
            Object fluid = getFluid.invoke(null, stack);
            if (fluid instanceof FluidStack && ((FluidStack) fluid).getFluid() != null) {
                return ((FluidStack) fluid).getFluid().getName();
            }
        } catch (Throwable ignored) {
        }
        return null;
    }

    /**
     * The aspect an aspect item shows (2.9's aspectrecipeindex, 2.8.1's Thaumcraft NEI plugin):
     * the plugin's own getAspects where it has one, else Thaumcraft's AspectList NBT ("Aspects",
     * each with a "key"). Only those items: essentia phials and jars carry the same NBT and are
     * items in the list, not aspects.
     */
    private static String aspectTag(ItemStack stack, String registryId) {
        String domain = registryId.indexOf(':') > 0
            ? registryId.substring(0, registryId.indexOf(':')).toLowerCase(Locale.ROOT)
            : "";
        boolean aspectItem = "aspectrecipeindex".equals(domain)
            || "thaumcraftneiplugin".equals(domain)
            || "ItemAspect".equals(stack.getItem().getClass().getSimpleName());
        if (!aspectItem) {
            return null;
        }
        try {
            Object list = Class.forName("com.djgiannuzz.thaumcraftneiplugin.items.ItemAspect")
                .getMethod("getAspects", ItemStack.class)
                .invoke(null, stack);
            Object[] aspects = list == null ? null : (Object[]) list.getClass().getMethod("getAspects").invoke(list);
            if (aspects != null && aspects.length > 0 && aspects[0] != null) {
                Object key = aspects[0].getClass().getMethod("getTag").invoke(aspects[0]);
                if (key != null && String.valueOf(key).length() > 0) {
                    return String.valueOf(key);
                }
            }
        } catch (Throwable ignored) {
        }
        NBTTagCompound tag = stack.getTagCompound();
        if (tag == null || !tag.hasKey("Aspects")) {
            return null;
        }
        NBTTagList aspects = tag.getTagList("Aspects", 10);
        if (aspects.tagCount() == 0) {
            return null;
        }
        String key = aspects.getCompoundTagAt(0).getString("key");
        return key == null || key.length() == 0 ? null : key;
    }

    private static Method staticMethod(String className, String name, Class<?>... parameters) {
        try {
            return Class.forName(className).getMethod(name, parameters);
        } catch (Throwable absent) {
            return null;
        }
    }
}
