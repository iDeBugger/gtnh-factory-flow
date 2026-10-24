package dev.gtnhplanner.calcoracle;

import bartworks.API.recipe.BartWorksRecipeMaps;
import gregtech.api.recipe.RecipeMap;
import gregtech.api.util.GTRecipe;
import gregtech.api.util.GTRecipeConstants;
import gregtech.api.util.recipe.Sievert;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraftforge.fluids.FluidStack;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The Tree Growth Simulator's, Bacterial Vat's and radio hatch's facts the recipe export lacks,
 * in the shape tools/audits/import-machine-side-data.mjs reads (trees[], recipes[], materials[]).
 * A step-for-step port of the in-game planner mod's machinedata export (DevMachineData), so the
 * importer writes the same src/lib/machines/data files from either.
 *
 * The bartworks maps and recipe metadata keys are the same in both packs' GregTech. The Tree
 * Growth Simulator moved from GT++ to GregTech between them, so its map and product table are
 * found by reflection.
 */
public final class MachineDataExport {

    /** Output slot i of a Tree Growth Simulator NEI recipe is MTETreeFarm.Mode ordinal i. */
    private static final String[] MODES = { "log", "sapling", "leaves", "fruit" };
    private static final String[] TREE_MAP_HOLDERS = {
        "gregtech.api.recipe.RecipeMaps",
        "gtPlusPlus.api.recipe.GTPPRecipeMaps"
    };
    private static final String[] TREE_FARM_CLASSES = {
        "gregtech.common.tileentities.machines.multi.MTETreeFarm",
        "gtPlusPlus.xmod.gregtech.common.tileentities.machines.multi.production.MTETreeFarm"
    };

    private final MachineDataContext ctx;

    public MachineDataExport(MachineDataContext ctx) {
        this.ctx = ctx;
    }

    public Map<String, Object> trees() throws Exception {
        RecipeMap<?> treeMap = (RecipeMap<?>) staticField(TREE_MAP_HOLDERS, "treeGrowthSimulatorFakeRecipes");
        Map<?, ?> products = (Map<?, ?>) staticField(TREE_FARM_CLASSES, "treeProductsMap");
        List<Object> list = new ArrayList<Object>();
        for (GTRecipe r : treeMap.getAllRecipes()) {
            if (!(r.mSpecialItems instanceof ItemStack)) {
                continue;
            }
            ItemStack sapling = (ItemStack) r.mSpecialItems;
            Map<String, Object> t = ctx.map();
            t.put("sapling", item(sapling, 1));
            Map<String, Object> outputs = ctx.map();
            for (int mode = 0; mode < MODES.length; mode++) {
                ItemStack out = r.mOutputs != null && mode < r.mOutputs.length ? r.mOutputs[mode] : null;
                if (out != null) {
                    outputs.put(MODES[mode], item(out, out.stackSize));
                }
            }
            t.put("outputs", outputs);
            t.put("forestry", forestry(sapling, products));
            list.add(t);
        }
        Map<String, Object> o = ctx.map();
        o.put("source", "MTETreeFarm's NEI recipes (gt.recipe.treefarm): outputs are NEI's, the product x the mode's multiplier");
        o.put("trees", list);
        return o;
    }

    /**
     * A Forestry sapling's species, its default genes, and its products before the genes scale
     * them; null for any other sapling. Forestry is reached by reflection.
     */
    private Map<String, Object> forestry(ItemStack sapling, Map<?, ?> products) {
        String name = Item.itemRegistry.getNameForObject(sapling.getItem());
        if (!"Forestry:sapling".equals(name)) {
            return null;
        }
        try {
            Object root = Class.forName("forestry.api.arboriculture.TreeManager").getField("treeRoot").get(null);
            Object tree = root.getClass().getMethod("getMember", ItemStack.class).invoke(root, sapling);
            if (tree == null) {
                return null;
            }
            Object genome = call(tree, "getGenome");
            Map<String, Object> f = ctx.map();
            f.put("species", call(tree, "getIdent"));
            f.put("height", call(genome, "getHeight"));
            f.put("girth", call(genome, "getGirth"));
            f.put("fertility", call(genome, "getFertility"));
            f.put("yield", call(genome, "getYield"));
            Object base = products.get("Forestry:sapling:" + f.get("species"));
            Map<String, Object> counts = ctx.map();
            List<String> unread = new ArrayList<String>();
            if (base instanceof Map) {
                for (Map.Entry<?, ?> e : ((Map<?, ?>) base).entrySet()) {
                    String mode = ((Enum<?>) e.getKey()).name().toLowerCase(Locale.ROOT);
                    // 2.8.1 keeps a product the tree lacks (Dark Oak's fruit) as a null stack; 2.9 leaves
                    // it out. Either way the tree makes none of it, so the mode is left out.
                    if (e.getValue() == null) {
                        continue;
                    }
                    // Anything else is a product this export cannot count: it is reported as an error,
                    // which the importer refuses, rather than dropped as if the tree made none.
                    if (!(e.getValue() instanceof ItemStack)) {
                        unread.add(mode + " is a " + e.getValue().getClass().getName());
                        continue;
                    }
                    counts.put(mode, Integer.valueOf(((ItemStack) e.getValue()).stackSize));
                }
            }
            f.put("base", counts);
            if (!unread.isEmpty()) {
                f.put("error", "products that are not item stacks: " + String.join(", ", unread));
            }
            return f;
        } catch (ReflectiveOperationException | RuntimeException e) {
            Map<String, Object> f = ctx.map();
            f.put("error", String.valueOf(e));
            return f;
        }
    }

    /** Every Bacterial Vat recipe: its culture, what it takes and makes, its time and power, glass and sieverts. */
    public Map<String, Object> vat() {
        List<Object> list = new ArrayList<Object>();
        for (GTRecipe r : BartWorksRecipeMaps.bacterialVatRecipes.getAllRecipes()) {
            Map<String, Object> v = ctx.map();
            ItemStack dish = r.mSpecialItems instanceof ItemStack ? (ItemStack) r.mSpecialItems : null;
            v.put("culture", dish != null && dish.hasTagCompound() ? dish.getTagCompound().getString("Name") : null);
            v.put("items", items(r.mInputs));
            v.put("itemOutputs", items(r.mOutputs));
            v.put("fluidIn", r.mFluidInputs != null && r.mFluidInputs.length > 0 ? fluid(r.mFluidInputs[0]) : null);
            v.put("fluidOut", r.mFluidOutputs != null && r.mFluidOutputs.length > 0 ? fluid(r.mFluidOutputs[0]) : null);
            v.put("durationTicks", Integer.valueOf(r.mDuration));
            v.put("eut", r.mEUt);
            v.put("glass", r.getMetadataOrDefault(GTRecipeConstants.GLASS, Integer.valueOf(0)));
            Sievert sv = r.getMetadataOrDefault(GTRecipeConstants.SIEVERT, new Sievert(0, false));
            v.put("sievert", Integer.valueOf(sv.sievert));
            v.put("exact", Boolean.valueOf(sv.isExact));
            v.put("cleanroom", r.getMetadataOrDefault(GTRecipeConstants.CLEANROOM, Boolean.FALSE));
            list.add(v);
        }
        Map<String, Object> o = ctx.map();
        o.put("source", "bartworks' Bacterial Vat map (bw.recipe.BacteriaVat), GLASS and SIEVERT metadata");
        o.put("recipes", list);
        return o;
    }

    /** The radio hatch's materials: each item, its sieverts and its mass (its NEI page, bw.recipe.radhatch). */
    public Map<String, Object> radioHatch() {
        List<Object> list = new ArrayList<Object>();
        for (GTRecipe r : BartWorksRecipeMaps.radioHatchFakeRecipes.getAllRecipes()) {
            if (r.mInputs == null || r.mInputs.length == 0 || r.mInputs[0] == null) {
                continue;
            }
            Map<String, Object> m = item(r.mInputs[0], 1);
            m.put("sievert", Integer.valueOf(r.getMetadataOrDefault(GTRecipeConstants.SIEVERT, new Sievert(0, false)).sievert));
            m.put("mass", r.getMetadataOrDefault(GTRecipeConstants.MASS, Integer.valueOf(0)));
            list.add(m);
        }
        Map<String, Object> o = ctx.map();
        o.put("source", "bartworks' radio hatch materials (bw.recipe.radhatch): SIEVERT and MASS metadata");
        o.put("materials", list);
        return o;
    }

    private List<Object> items(ItemStack[] stacks) {
        List<Object> a = new ArrayList<Object>();
        if (stacks != null) {
            for (ItemStack s : stacks) {
                if (s != null) {
                    a.add(item(s, s.stackSize));
                }
            }
        }
        return a;
    }

    /** An item by the dataset's id, its name in this game and an amount. */
    private Map<String, Object> item(ItemStack s, int amount) {
        Map<String, Object> o = ctx.map();
        String id = ctx.itemId(s);
        o.put("id", id);
        String name;
        try {
            name = s.getDisplayName();
        } catch (RuntimeException e) {
            name = id;
        }
        o.put("name", name);
        o.put("amount", Integer.valueOf(amount));
        return o;
    }

    private Map<String, Object> fluid(FluidStack f) {
        if (f == null || f.getFluid() == null) {
            return null;
        }
        Map<String, Object> o = ctx.map();
        o.put("id", ctx.fluidId(f));
        o.put("name", f.getLocalizedName());
        o.put("amount", Integer.valueOf(f.amount));
        return o;
    }

    private static Object call(Object on, String method) throws ReflectiveOperationException {
        return on.getClass().getMethod(method).invoke(on);
    }

    /** The first of these classes that has the static field, and its value. */
    private static Object staticField(String[] classNames, String field) throws Exception {
        for (String className : classNames) {
            Class<?> type;
            try {
                type = Class.forName(className);
            } catch (ClassNotFoundException e) {
                continue;
            }
            try {
                Object value = type.getField(field).get(null);
                if (value != null) {
                    return value;
                }
            } catch (NoSuchFieldException ignored) {
                // The next class may hold it.
            }
        }
        throw new IllegalStateException("No static " + field + " on any of " + String.join(", ", classNames));
    }
}
