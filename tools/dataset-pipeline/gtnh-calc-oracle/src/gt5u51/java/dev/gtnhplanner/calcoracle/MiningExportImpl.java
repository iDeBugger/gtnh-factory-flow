package dev.gtnhplanner.calcoracle;

import gregtech.api.enums.Materials;
import gtneioreplugin.util.DimensionHelper;
import gtneioreplugin.util.GT5OreLayerHelper;
import gtneioreplugin.util.GT5OreSmallHelper;
import gtneioreplugin.util.GT5UndergroundFluidHelper;
import gtneioreplugin.util.OreVeinLayer;
import net.minecraft.item.ItemStack;
import net.minecraftforge.fluids.Fluid;
import net.minecraftforge.fluids.FluidRegistry;
import net.minecraftforge.fluids.FluidStack;

import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * The mining domain for GT5U 5.09.51 (GTNH 2.8.1). It writes the same JSON shape as the
 * 5.09.54 copy. Fields this NEI ore plugin does not have (a dimension's rocket tier,
 * per-dimension height ranges, a small ore's enabled-dimension list) are left out rather
 * than invented, so the normalizer falls back exactly as it does for any missing field.
 */
public final class MiningExportImpl implements MiningExport {

    @Override
    public Map<String, Object> exportMining(List<Map<String, Object>> adapters, MiningContext ctx) {
        Map<String, Object> domain = ctx.domain("mining");
        domain.put(
            "notes",
            "GregTech worldgen exported through the NEI ore plugin helpers bundled in GT5-Unofficial. A vein's"
                + " weight is its relative pick weight among the veins that can generate in a dimension; dimChances"
                + " are the plugin's computed per-dimension probabilities keyed by dimension abbreviation. Density"
                + " and size describe how the picked vein fills chunks. Small ores generate independently at"
                + " amountPerChunk tries per chunk, and undergroundFluids list per-dimension chunk deposits.");
        List<Map<String, Object>> dimensions = new ArrayList<Map<String, Object>>();
        try {
            // The three arrays run in step: DimName[i] is the internal name, DimNameTrimmed[i]
            // its short form, DimNameDisplayed[i] its abbreviation. Veins name their dimensions
            // by the worldgen name getFullName returns, so that is the fullName alias.
            String[] internal = DimensionHelper.DimName;
            String[] trimmed = DimensionHelper.DimNameTrimmed;
            String[] displayed = DimensionHelper.DimNameDisplayed;
            for (int index = 0; index < internal.length; index++) {
                if (internal[index] == null) {
                    continue;
                }
                String displayedAbbr = index < displayed.length ? displayed[index] : null;
                String fullName = null;
                String abbr = displayedAbbr;
                if (displayedAbbr != null) {
                    try {
                        fullName = DimensionHelper.getFullName(displayedAbbr);
                        abbr = DimensionHelper.getDimAbbreviatedName(fullName);
                    } catch (Throwable ignored) {
                        // Both helpers throw on a name they do not know; keep what the arrays give.
                    }
                }
                Map<String, Object> exported = ctx.map();
                exported.put("id", ctx.safeString(internal[index]));
                ctx.putIfPresent(exported, "name", index < trimmed.length ? ctx.safeString(trimmed[index]) : null);
                ctx.putIfPresent(exported, "fullName", fullName == null ? null : ctx.safeString(fullName));
                ctx.putIfPresent(exported, "abbr", abbr == null ? null : ctx.safeString(abbr));
                dimensions.add(exported);
            }
        } catch (Throwable ignored) {
            // A failure here also fails the vein export below, which reports it.
        }
        domain.put("dimensions", dimensions);
        exportMiningOreVeins(adapters, domain, ctx);
        exportMiningSmallOres(adapters, domain, ctx);
        exportMiningUndergroundFluids(adapters, domain, ctx);
        return domain;
    }

    private void exportMiningOreVeins(List<Map<String, Object>> adapters, Map<String, Object> domain, MiningContext ctx) {
        long started = System.currentTimeMillis();
        List<Map<String, Object>> veins = new ArrayList<Map<String, Object>>();
        try {
            Map<String, GT5OreLayerHelper.OreLayerWrapper> byName = GT5OreLayerHelper.mapOreLayerWrapper;
            if (byName.isEmpty()) {
                // The NEI plugin fills these maps when its handlers first open, which never
                // happens on the autorun path. init() appends into final maps, so a second
                // call would count every vein twice in the per-dimension weights.
                GT5OreLayerHelper.init();
            }

            Map<GT5OreLayerHelper.OreLayerWrapper, Map<String, Object>> chancesByVein =
                new IdentityHashMap<GT5OreLayerHelper.OreLayerWrapper, Map<String, Object>>();
            for (Map.Entry<String, GT5OreLayerHelper.NormalOreDimensionWrapper> dimEntry
                : new TreeMap<String, GT5OreLayerHelper.NormalOreDimensionWrapper>(GT5OreLayerHelper.dimToOreWrapper)
                    .entrySet()) {
                if (dimEntry.getValue() == null || dimEntry.getValue().oreVeinToProbabilityInDimension == null) {
                    continue;
                }
                for (Map.Entry<GT5OreLayerHelper.OreLayerWrapper, Double> chance : dimEntry.getValue()
                    .oreVeinToProbabilityInDimension.entrySet()) {
                    Map<String, Object> chances = chancesByVein.get(chance.getKey());
                    if (chances == null) {
                        chances = ctx.map();
                        chancesByVein.put(chance.getKey(), chances);
                    }
                    chances.put(dimEntry.getKey(), chance.getValue());
                }
            }

            // HashMap order is not the game's; sort by vein name so two exports line up.
            for (GT5OreLayerHelper.OreLayerWrapper vein
                : new TreeMap<String, GT5OreLayerHelper.OreLayerWrapper>(byName).values()) {
                if (vein == null) {
                    continue;
                }
                veins.add(oreVein(vein, chancesByVein.get(vein), ctx));
            }
            domain.put("veins", veins);
            String status = veins.isEmpty() ? "partial" : "computed";
            String warning = veins.isEmpty()
                ? "GregTech ore vein helper was present, but no veins were exported."
                : null;
            adapters.add(ctx.adapter("gregtech-ore-veins", status, true, byName.size(), veins.size(), started, warning));
        } catch (Throwable t) {
            adapters.add(ctx.adapter("gregtech-ore-veins", "partial", true, 0, veins.size(), started, t.toString()));
            domain.put("veins", veins);
        }
    }

    private Map<String, Object> oreVein(
        GT5OreLayerHelper.OreLayerWrapper vein, Map<String, Object> dimChances, MiningContext ctx) {
        Map<String, Object> exported = ctx.map();
        exported.put("id", ctx.safeString(vein.veinName));
        String name = vein.localizedName == null || vein.localizedName.isEmpty() ? vein.veinName : vein.localizedName;
        exported.put("name", ctx.safeString(name));
        exported.put("weight", Integer.valueOf(vein.randomWeight));
        exported.put("density", Integer.valueOf(vein.density));
        exported.put("size", Integer.valueOf(vein.size));
        ctx.putIfPresent(exported, "heightRange", vein.worldGenHeightRange);
        List<String> dims = enabledDims(vein.allowedDimWithOrigNames);
        if (dims != null) {
            exported.put("dims", dims);
            List<String> abbrs = abbreviations(dims);
            if (abbrs != null) {
                exported.put("dimAbbrs", abbrs);
            }
        }
        if (dimChances != null && !dimChances.isEmpty()) {
            exported.put("dimChances", dimChances);
        }

        List<Map<String, Object>> ores = new ArrayList<Map<String, Object>>();
        String[] roles = new String[] { "primary", "secondary", "between", "sporadic" };
        int[] layerIds = new int[] {
            OreVeinLayer.VEIN_PRIMARY, OreVeinLayer.VEIN_SECONDARY, OreVeinLayer.VEIN_BETWEEN,
            OreVeinLayer.VEIN_SPORADIC
        };
        Materials[] materials = new Materials[] {
            vein.mPrimaryVeinMaterial, vein.mSecondaryMaterial, vein.mBetweenMaterial, vein.mSporadicMaterial
        };
        for (int index = 0; index < roles.length; index++) {
            Materials material = materials[index];
            if (material == null) {
                continue;
            }
            Map<String, Object> layer = ctx.map();
            layer.put("role", roles[index]);
            ctx.putIfPresent(layer, "material", oreMaterial(material, ctx));
            ctx.putIfPresent(layer, "ore", ctx.itemStack(veinLayerOre(vein, layerIds[index])));
            ores.add(layer);
        }
        exported.put("ores", ores);
        return exported;
    }

    // Material index 0 is the plain stone variant, the block NEI shows for the layer.
    private ItemStack veinLayerOre(GT5OreLayerHelper.OreLayerWrapper vein, int layer) {
        try {
            return vein.getLayerOre(layer, 0);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private Map<String, Object> oreMaterial(Materials material, MiningContext ctx) {
        if (material == null) {
            return null;
        }
        Map<String, Object> exported = ctx.map();
        exported.put("id", Integer.valueOf(material.mMetaItemSubID));
        ctx.putIfPresent(exported, "internalName", material.mName);
        String name = material.mLocalizedName == null || material.mLocalizedName.isEmpty()
            ? material.mDefaultLocalName
            : material.mLocalizedName;
        ctx.putIfPresent(exported, "name", name);
        return exported;
    }

    // The plugin keeps every dimension it knows with a flag; only the true ones generate.
    private List<String> enabledDims(Map<String, Boolean> allowed) {
        if (allowed == null) {
            return null;
        }
        List<String> dims = new ArrayList<String>();
        for (Map.Entry<String, Boolean> entry : new TreeMap<String, Boolean>(allowed).entrySet()) {
            if (Boolean.TRUE.equals(entry.getValue())) {
                dims.add(entry.getKey());
            }
        }
        return dims;
    }

    // Abbreviations only when every dimension has one: a partial list would read as a
    // vein that generates in fewer places.
    private List<String> abbreviations(List<String> dims) {
        List<String> abbrs = new ArrayList<String>();
        for (String dim : dims) {
            try {
                abbrs.add(DimensionHelper.getDimAbbreviatedName(dim));
            } catch (Throwable ignored) {
                return null;
            }
        }
        return abbrs;
    }

    private void exportMiningSmallOres(List<Map<String, Object>> adapters, Map<String, Object> domain, MiningContext ctx) {
        long started = System.currentTimeMillis();
        List<Map<String, Object>> smallOres = new ArrayList<Map<String, Object>>();
        try {
            Map<String, GT5OreSmallHelper.OreSmallWrapper> byName = GT5OreSmallHelper.mapOreSmallWrapper;
            if (byName.isEmpty()) {
                // init() appends into final collections, so it must only run when they are
                // still empty.
                GT5OreSmallHelper.init();
            }
            for (GT5OreSmallHelper.OreSmallWrapper small
                : new TreeMap<String, GT5OreSmallHelper.OreSmallWrapper>(byName).values()) {
                if (small == null) {
                    continue;
                }
                Map<String, Object> exported = ctx.map();
                exported.put("id", ctx.safeString(small.oreGenName));
                ctx.putIfPresent(exported, "material", oreMaterial(small.getOreMaterial(), ctx));
                ctx.putIfPresent(exported, "heightRange", small.worldGenHeightRange);
                exported.put("amountPerChunk", Integer.valueOf(small.amountPerChunk));
                List<String> dims = enabledDims(small.allowedDimWithOrigNames);
                if (dims != null) {
                    exported.put("dims", dims);
                }
                List<Map<String, Object>> drops = new ArrayList<Map<String, Object>>();
                List<ItemStack> rawDrops = GT5OreSmallHelper.mapOreMetaToOreDrops.get(Short.valueOf(small.oreMeta));
                for (ItemStack drop : rawDrops == null ? Collections.<ItemStack>emptyList() : rawDrops) {
                    Map<String, Object> exportedDrop = ctx.itemStack(drop);
                    if (exportedDrop != null) {
                        drops.add(exportedDrop);
                    }
                }
                ctx.putIfPresent(exported, "drops", drops);
                smallOres.add(exported);
            }
            domain.put("smallOres", smallOres);
            String status = smallOres.isEmpty() ? "partial" : "computed";
            String warning = smallOres.isEmpty()
                ? "GregTech small ore helper was present, but no small ores were exported."
                : null;
            adapters.add(
                ctx.adapter("gregtech-small-ores", status, true, byName.size(), smallOres.size(), started, warning));
        } catch (Throwable t) {
            adapters.add(ctx.adapter("gregtech-small-ores", "partial", true, 0, smallOres.size(), started, t.toString()));
            domain.put("smallOres", smallOres);
        }
    }

    private void exportMiningUndergroundFluids(List<Map<String, Object>> adapters, Map<String, Object> domain, MiningContext ctx) {
        long started = System.currentTimeMillis();
        List<Map<String, Object>> fluids = new ArrayList<Map<String, Object>>();
        try {
            Map<String, List<GT5UndergroundFluidHelper.UndergroundFluidWrapper>> all =
                GT5UndergroundFluidHelper.getAllEntries();
            if (all == null || all.isEmpty()) {
                // init() appends deposits to the lists it finds, so only run it on an empty map.
                GT5UndergroundFluidHelper.init();
                all = GT5UndergroundFluidHelper.getAllEntries();
            }
            for (Map.Entry<String, List<GT5UndergroundFluidHelper.UndergroundFluidWrapper>> entry
                : (all == null
                    ? Collections.<String, List<GT5UndergroundFluidHelper.UndergroundFluidWrapper>>emptyMap()
                    : new TreeMap<String, List<GT5UndergroundFluidHelper.UndergroundFluidWrapper>>(all)).entrySet()) {
                Map<String, Object> exported = ctx.map();
                exported.put("fluidId", ctx.safeString(entry.getKey()));
                Fluid fluid = FluidRegistry.getFluid(entry.getKey());
                if (fluid != null) {
                    ctx.putIfPresent(exported, "fluid", ctx.fluidStack(new FluidStack(fluid, 1)));
                }
                List<Map<String, Object>> deposits = new ArrayList<Map<String, Object>>();
                for (GT5UndergroundFluidHelper.UndergroundFluidWrapper wrapper
                    : entry.getValue() == null
                        ? Collections.<GT5UndergroundFluidHelper.UndergroundFluidWrapper>emptyList()
                        : entry.getValue()) {
                    if (wrapper == null) {
                        continue;
                    }
                    Map<String, Object> deposit = ctx.map();
                    deposit.put("dim", ctx.safeString(wrapper.dimension));
                    deposit.put("chance", Integer.valueOf(wrapper.chance));
                    deposit.put("minAmount", Integer.valueOf(wrapper.minAmount));
                    deposit.put("maxAmount", Integer.valueOf(wrapper.maxAmount));
                    deposits.add(deposit);
                }
                exported.put("deposits", deposits);
                fluids.add(exported);
            }
            domain.put("undergroundFluids", fluids);
            String status = fluids.isEmpty() ? "partial" : "computed";
            String warning = fluids.isEmpty()
                ? "GregTech underground fluid helper was present, but no fluids were exported."
                : null;
            adapters.add(
                ctx.adapter("gregtech-underground-fluids", status, true, fluids.size(), fluids.size(), started, warning));
        } catch (Throwable t) {
            adapters
                .add(ctx.adapter("gregtech-underground-fluids", "partial", true, 0, fluids.size(), started, t.toString()));
            domain.put("undergroundFluids", fluids);
        }
    }
}
