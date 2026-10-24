package dev.gtnhplanner.calcoracle;

import gregtech.api.enums.StoneType;
import gregtech.api.interfaces.IOreMaterial;
import gregtech.api.interfaces.IStoneType;
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
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The mining domain for GT5U 5.09.54 (GTNH 2.9). The NEI ore plugin's helper API differs
 * between GT versions, so each pack's build compiles its own copy of this class from its
 * own source dir (see dependencies.gradle).
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
            for (DimensionHelper.Dimension dimension : DimensionHelper.ALL_DIMENSIONS) {
                if (dimension == null) {
                    continue;
                }
                Map<String, Object> exported = ctx.map();
                exported.put("id", ctx.safeString(dimension.internalName()));
                ctx.putIfPresent(exported, "name", ctx.safeString(dimension.trimmedName()));
                ctx.putIfPresent(exported, "fullName", ctx.safeString(dimension.fullName()));
                ctx.putIfPresent(exported, "abbr", ctx.safeString(dimension.abbr()));
                ctx.putIfPresent(exported, "tier", ctx.safeString(dimension.tierKey()));
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

    private void exportMiningOreVeins(
        List<Map<String, Object>> adapters, Map<String, Object> domain, MiningContext ctx) {
        long started = System.currentTimeMillis();
        List<Map<String, Object>> veins = new ArrayList<Map<String, Object>>();
        try {
            Map<String, GT5OreLayerHelper.OreLayerWrapper> byName = GT5OreLayerHelper.getOreVeinsByName();
            if (byName == null || byName.isEmpty()) {
                // The NEI plugin fills these caches when its handlers first open, which
                // never happens on the autorun path. init() rebuilds fresh immutable maps
                // from the OreMixes enum, so calling it again is harmless.
                GT5OreLayerHelper.init();
                byName = GT5OreLayerHelper.getOreVeinsByName();
            }

            Map<GT5OreLayerHelper.OreLayerWrapper, Map<String, Object>> chancesByVein =
                new IdentityHashMap<GT5OreLayerHelper.OreLayerWrapper, Map<String, Object>>();
            Map<String, GT5OreLayerHelper.NormalOreDimensionWrapper> byDim = GT5OreLayerHelper.getOreVeinsByDim();
            for (Map.Entry<String, GT5OreLayerHelper.NormalOreDimensionWrapper> dimEntry
                : (byDim == null ? Collections.<String, GT5OreLayerHelper.NormalOreDimensionWrapper>emptyMap() : byDim)
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

            for (GT5OreLayerHelper.OreLayerWrapper vein : byName.values()) {
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
            adapters.add(
                ctx.adapter("gregtech-ore-veins", status, true, byName.size(), veins.size(), started, warning));
        } catch (Throwable t) {
            adapters.add(ctx.adapter("gregtech-ore-veins", "partial", true, 0, veins.size(), started, t.toString()));
            domain.put("veins", veins);
        }
    }

    private Map<String, Object> oreVein(
        GT5OreLayerHelper.OreLayerWrapper vein, Map<String, Object> dimChances, MiningContext ctx) {
        Map<String, Object> exported = ctx.map();
        exported.put("id", ctx.safeString(vein.veinName));
        String name;
        try {
            name = vein.getLocalizedName();
        } catch (Throwable ignored) {
            name = vein.veinName;
        }
        exported.put("name", ctx.safeString(name));
        exported.put("weight", Integer.valueOf(vein.randomWeight));
        exported.put("density", Integer.valueOf(vein.density));
        exported.put("size", Integer.valueOf(vein.size));
        ctx.putIfPresent(exported, "heightRange", vein.worldGenHeightRange);
        if (vein.allowedDimWithOrigNames != null) {
            exported.put("dims", new ArrayList<String>(vein.allowedDimWithOrigNames));
        }
        if (vein.abbrDimNames != null) {
            exported.put("dimAbbrs", new ArrayList<String>(vein.abbrDimNames));
        }
        if (vein.dimWorldGenHeightRange != null && !vein.dimWorldGenHeightRange.isEmpty()) {
            exported.put("dimHeightRanges", new LinkedHashMap<String, String>(vein.dimWorldGenHeightRange));
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
        for (int index = 0; index < roles.length; index++) {
            IOreMaterial material = vein.ores != null && layerIds[index] < vein.ores.length
                ? vein.ores[layerIds[index]]
                : null;
            if (material == null) {
                continue;
            }
            Map<String, Object> layer = ctx.map();
            layer.put("role", roles[index]);
            ctx.putIfPresent(layer, "material", oreMaterial(material, ctx));
            ctx.putIfPresent(layer, "ore", ctx.itemStack(veinLayerOre(vein, layerIds[index], material)));
            ores.add(layer);
        }
        exported.put("ores", ores);
        return exported;
    }

    private ItemStack veinLayerOre(GT5OreLayerHelper.OreLayerWrapper vein, int layer, IOreMaterial material) {
        try {
            IStoneType stone = null;
            List<IStoneType> validStones = material.getValidStones();
            if (validStones != null && !validStones.isEmpty()) {
                stone = validStones.get(0);
            }
            if (stone == null) {
                stone = StoneType.Stone;
            }
            return vein.getLayerOre(layer, stone);
        } catch (Throwable ignored) {
            return null;
        }
    }

    private Map<String, Object> oreMaterial(IOreMaterial material, MiningContext ctx) {
        if (material == null) {
            return null;
        }
        Map<String, Object> exported = ctx.map();
        exported.put("id", Integer.valueOf(material.getId()));
        ctx.putIfPresent(exported, "internalName", material.getInternalName());
        String name;
        try {
            name = material.getLocalizedName();
        } catch (Throwable ignored) {
            name = material.getDefaultLocalName();
        }
        ctx.putIfPresent(exported, "name", name);
        return exported;
    }

    private void exportMiningSmallOres(
        List<Map<String, Object>> adapters, Map<String, Object> domain, MiningContext ctx) {
        long started = System.currentTimeMillis();
        List<Map<String, Object>> smallOres = new ArrayList<Map<String, Object>>();
        try {
            Map<String, GT5OreSmallHelper.OreSmallWrapper> byName = GT5OreSmallHelper.SMALL_ORES_BY_NAME;
            if (byName.isEmpty()) {
                // Unlike the vein helper, init() appends into final collections, so it
                // must only run when they are still empty.
                GT5OreSmallHelper.init();
            }
            for (GT5OreSmallHelper.OreSmallWrapper small : byName.values()) {
                if (small == null) {
                    continue;
                }
                Map<String, Object> exported = ctx.map();
                exported.put("id", ctx.safeString(small.oreGenName));
                ctx.putIfPresent(exported, "material", oreMaterial(small.material, ctx));
                ctx.putIfPresent(exported, "heightRange", small.worldGenHeightRange);
                exported.put("amountPerChunk", Integer.valueOf(small.amountPerChunk));
                if (small.allowedDimWithOrigNames != null) {
                    exported.put("dims", new ArrayList<String>(small.allowedDimWithOrigNames));
                }
                if (small.enabledDims != null) {
                    exported.put("enabledDims", new ArrayList<String>(small.enabledDims));
                }
                List<Map<String, Object>> drops = new ArrayList<Map<String, Object>>();
                List<ItemStack> rawDrops = GT5OreSmallHelper.ORE_MAT_TO_DROPS.get(small.material);
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
            adapters.add(
                ctx.adapter("gregtech-small-ores", "partial", true, 0, smallOres.size(), started, t.toString()));
            domain.put("smallOres", smallOres);
        }
    }

    private void exportMiningUndergroundFluids(
        List<Map<String, Object>> adapters, Map<String, Object> domain, MiningContext ctx) {
        long started = System.currentTimeMillis();
        List<Map<String, Object>> fluids = new ArrayList<Map<String, Object>>();
        try {
            Map<String, List<GT5UndergroundFluidHelper.UndergroundFluidWrapper>> all =
                GT5UndergroundFluidHelper.getAllEntries();
            if (all == null || all.isEmpty()) {
                GT5UndergroundFluidHelper.init();
                all = GT5UndergroundFluidHelper.getAllEntries();
            }
            for (Map.Entry<String, List<GT5UndergroundFluidHelper.UndergroundFluidWrapper>> entry
                : (all == null
                    ? Collections.<String, List<GT5UndergroundFluidHelper.UndergroundFluidWrapper>>emptyMap()
                    : all).entrySet()) {
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
                ctx.adapter(
                    "gregtech-underground-fluids", status, true, fluids.size(), fluids.size(), started, warning));
        } catch (Throwable t) {
            adapters.add(
                ctx.adapter(
                    "gregtech-underground-fluids", "partial", true, 0, fluids.size(), started, t.toString()));
            domain.put("undergroundFluids", fluids);
        }
    }
}
