package dev.gtnhplanner.calcoracle;

import bartworks.system.material.Werkstoff;
import bartworks.system.oregen.BWOreLayer;
import bartworks.system.oregen.BWWorldGenRoss128b;
import bartworks.system.oregen.BWWorldGenRoss128ba;
import galacticgreg.api.enums.DimensionDef;
import gregtech.api.GregTechAPI;
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
import toxiceverglades.gen.WorldGenEvergladesOreLayer;
import toxiceverglades.gen.WorldGenEvergladesOres;

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
            // its short form, DimNameDisplayed[i] its abbreviation, exported as is (getDims keys
            // veins by the same abbreviations). Veins name their dimensions by the worldgen name
            // getFullName returns, so that is the fullName alias.
            String[] internal = DimensionHelper.DimName;
            String[] trimmed = DimensionHelper.DimNameTrimmed;
            String[] displayed = DimensionHelper.DimNameDisplayed;
            for (int index = 0; index < internal.length; index++) {
                if (internal[index] == null) {
                    continue;
                }
                String displayedAbbr = index < displayed.length ? displayed[index] : null;
                String fullName = null;
                if (displayedAbbr != null) {
                    try {
                        fullName = DimensionHelper.getFullName(displayedAbbr);
                    } catch (Throwable ignored) {
                        // The helper throws on a name it does not know; the dimension then has no alias.
                    }
                }
                Map<String, Object> exported = ctx.map();
                exported.put("id", ctx.safeString(internal[index]));
                ctx.putIfPresent(exported, "name", index < trimmed.length ? ctx.safeString(trimmed[index]) : null);
                ctx.putIfPresent(exported, "fullName", fullName == null ? null : ctx.safeString(fullName));
                ctx.putIfPresent(exported, "abbr", displayedAbbr == null ? null : ctx.safeString(displayedAbbr));
                dimensions.add(exported);
            }
        } catch (Throwable ignored) {
            // A failure here also fails the vein export below, which reports it.
        }
        try {
            // The NEI plugin's arrays leave the Toxic Everglades out; its veins name it, so
            // list it the way 2.9's plugin does, or they would lose its abbreviation.
            if (!WorldGenEvergladesOreLayer.sList.isEmpty()) {
                Map<String, Object> everglades = ctx.map();
                everglades.put("id", EVERGLADES_DIM);
                everglades.put("name", EVERGLADES_DIM);
                everglades.put("fullName", EVERGLADES_DIM);
                everglades.put("abbr", EVERGLADES_ABBR);
                dimensions.add(everglades);
            }
        } catch (Throwable ignored) {
            // No Everglades in this pack: its veins are not exported either.
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
            TreeMap<String, Map<String, Object>> byId = new TreeMap<String, Map<String, Object>>();
            for (GT5OreLayerHelper.OreLayerWrapper vein
                : new TreeMap<String, GT5OreLayerHelper.OreLayerWrapper>(byName).values()) {
                if (vein == null) {
                    continue;
                }
                byId.put(vein.veinName, oreVein(vein, chancesByVein.get(vein), ctx));
            }
            // 5.09.51's NEI plugin lists only OreMixes. Bartworks' Ross128b/ba veins and the
            // Toxic Everglades veins generate from lists of their own, so read those too.
            List<String> extraWarnings = new ArrayList<String>();
            List<ExtraVein> extras = new ArrayList<ExtraVein>();
            try {
                ross128Veins(extras, ctx);
            } catch (Throwable t) {
                extraWarnings.add("bartworks Ross128 veins: " + t);
            }
            try {
                evergladesVeins(extras, ctx);
            } catch (Throwable t) {
                extraWarnings.add("Toxic Everglades veins: " + t);
            }
            addExtraVeins(byId, extras, ctx);
            veins.addAll(byId.values());
            if (!extraWarnings.isEmpty()) {
                StringBuilder joined = new StringBuilder();
                for (String warning : extraWarnings) {
                    joined.append(joined.length() == 0 ? "" : "; ").append(warning);
                }
                domain.put("veins", veins);
                adapters.add(ctx.adapter(
                    "gregtech-ore-veins", "partial", true, byName.size() + extras.size(), veins.size(), started,
                    joined.toString()));
                return;
            }
            domain.put("veins", veins);
            String status = veins.isEmpty() ? "partial" : "computed";
            String warning = veins.isEmpty()
                ? "GregTech ore vein helper was present, but no veins were exported."
                : null;
            adapters.add(ctx.adapter(
                "gregtech-ore-veins", status, true, byName.size() + extras.size(), veins.size(), started, warning));
        } catch (Throwable t) {
            adapters.add(ctx.adapter("gregtech-ore-veins", "partial", true, 0, veins.size(), started, t.toString()));
            domain.put("veins", veins);
        }
    }

    // A vein read from a worldgen list outside OreMixes, before its per-dimension chance is known.
    private static final class ExtraVein {
        String id;
        String name;
        int weight;
        int density;
        int size;
        String heightRange;
        String dim;
        String dimAbbr;
        List<Map<String, Object>> ores;
    }

    // The Toxic Everglades' world provider name. 5.09.51's NEI plugin does not know the
    // dimension, so it has no abbreviation there; Eg is the one 2.9's plugin gives it.
    private static final String EVERGLADES_DIM = "dimensionDarkWorld";
    private static final String EVERGLADES_ABBR = "Eg";

    // Adds the extra veins, with each one's chance among every vein of its dimension, the
    // rule the NEI plugin applies to OreMixes. A GT vein of the same id wins.
    private void addExtraVeins(TreeMap<String, Map<String, Object>> byId, List<ExtraVein> extras, MiningContext ctx) {
        Map<String, Integer> weightByDim = new TreeMap<String, Integer>();
        for (ExtraVein vein : extras) {
            if (byId.containsKey(vein.id)) {
                continue;
            }
            Integer sum = weightByDim.get(vein.dim);
            weightByDim.put(vein.dim, Integer.valueOf((sum == null ? 0 : sum.intValue()) + vein.weight));
        }
        for (Map<String, Object> gtVein : byId.values()) {
            Object dims = gtVein.get("dims");
            if (!(dims instanceof List)) {
                continue;
            }
            for (Object dim : (List<?>) dims) {
                Integer sum = weightByDim.get(dim);
                if (sum != null) {
                    int weight = ((Integer) gtVein.get("weight")).intValue();
                    weightByDim.put((String) dim, Integer.valueOf(sum.intValue() + weight));
                }
            }
        }
        for (ExtraVein vein : extras) {
            if (byId.containsKey(vein.id) || vein.ores.isEmpty()) {
                continue;
            }
            Map<String, Object> exported = ctx.map();
            exported.put("id", ctx.safeString(vein.id));
            exported.put("name", ctx.safeString(vein.name == null || vein.name.isEmpty() ? vein.id : vein.name));
            exported.put("weight", Integer.valueOf(vein.weight));
            exported.put("density", Integer.valueOf(vein.density));
            exported.put("size", Integer.valueOf(vein.size));
            exported.put("heightRange", vein.heightRange);
            exported.put("dims", Collections.singletonList(vein.dim));
            if (vein.dimAbbr != null) {
                exported.put("dimAbbrs", Collections.singletonList(vein.dimAbbr));
                int total = weightByDim.get(vein.dim).intValue();
                if (total > 0) {
                    Map<String, Object> chances = ctx.map();
                    chances.put(vein.dimAbbr, Double.valueOf(((double) vein.weight) / ((double) total)));
                    exported.put("dimChances", chances);
                }
            }
            exported.put("ores", vein.ores);
            byId.put(vein.id, exported);
        }
    }

    // Bartworks keeps its Ross128b and Ross128ba veins in BWOreLayer.sList (enabled ones
    // only). A layer is a GT material or a bartworks Werkstoff, told apart by bwOres.
    private void ross128Veins(List<ExtraVein> extras, MiningContext ctx) {
        String[] roles = new String[] { "primary", "secondary", "between", "sporadic" };
        for (BWOreLayer layer : new ArrayList<BWOreLayer>(BWOreLayer.sList)) {
            if (layer == null) {
                continue;
            }
            String dim;
            if (layer instanceof BWWorldGenRoss128ba) {
                dim = DimensionDef.DimNames.ROSS128BA;
            } else if (layer instanceof BWWorldGenRoss128b) {
                dim = DimensionDef.DimNames.ROSS128B;
            } else {
                continue;
            }
            ExtraVein vein = new ExtraVein();
            vein.id = layer.mWorldGenName;
            vein.weight = layer.mWeight;
            vein.density = layer.mDensity;
            vein.size = layer.mSize;
            vein.heightRange = layer.mMinY + "-" + layer.mMaxY;
            vein.dim = dim;
            List<String> abbrs = abbreviations(Collections.singletonList(dim));
            vein.dimAbbr = abbrs == null ? null : abbrs.get(0);
            vein.ores = new ArrayList<Map<String, Object>>();
            List<ItemStack> stacks = layer.getStacks();
            List<org.apache.commons.lang3.tuple.Pair<Integer, Boolean>> raw = layer.getStacksRawData();
            for (int index = 0; index < roles.length && index < raw.size(); index++) {
                int meta = raw.get(index).getLeft().intValue();
                boolean werkstoff = Boolean.TRUE.equals(raw.get(index).getRight());
                Map<String, Object> material;
                String materialName;
                if (werkstoff) {
                    Werkstoff found = Werkstoff.werkstoffHashMap.get(Short.valueOf((short) meta));
                    if (found == null) {
                        continue;
                    }
                    material = ctx.map();
                    material.put("id", Integer.valueOf(found.getmID()));
                    ctx.putIfPresent(material, "internalName", found.getVarName());
                    materialName = found.getLocalizedName();
                    ctx.putIfPresent(material, "name", materialName);
                } else {
                    Materials found = meta >= 0 && meta < GregTechAPI.sGeneratedMaterials.length
                        ? GregTechAPI.sGeneratedMaterials[meta]
                        : null;
                    if (found == null) {
                        continue;
                    }
                    material = oreMaterial(found, ctx);
                    materialName = (String) material.get("name");
                }
                // The vein is named after its primary layer, as 2.9 names these veins.
                if (index == 0) {
                    vein.name = materialName;
                }
                Map<String, Object> exportedLayer = ctx.map();
                exportedLayer.put("role", roles[index]);
                exportedLayer.put("material", material);
                ctx.putIfPresent(exportedLayer, "ore", index < stacks.size() ? ctx.itemStack(stacks.get(index)) : null);
                vein.ores.add(exportedLayer);
            }
            extras.add(vein);
        }
    }

    // The Toxic Everglades generate from WorldGenEvergladesOreLayer.sList (enabled ones
    // only). validOreveins numbers the same veins 0 to 19 in registration order, the
    // numbers 2.9 names them by (ore.mix.gtpp0 is the base Iron vein), so a vein keeps
    // its id across the two packs. Every 2.8.1 layer sets mMinY 5 and mMaxY 14 whatever
    // its constructor is given, so that is the height it generates at.
    private void evergladesVeins(List<ExtraVein> extras, MiningContext ctx) {
        List<WorldGenEvergladesOreLayer> enabled = WorldGenEvergladesOreLayer.sList;
        String[] roles = new String[] { "primary", "secondary", "between", "sporadic" };
        for (Map.Entry<Long, WorldGenEvergladesOreLayer> entry
            : new TreeMap<Long, WorldGenEvergladesOreLayer>(WorldGenEvergladesOres.validOreveins).entrySet()) {
            WorldGenEvergladesOreLayer layer = entry.getValue();
            if (layer == null || !containsIdentity(enabled, layer)) {
                continue;
            }
            ExtraVein vein = new ExtraVein();
            vein.id = "ore.mix.gtpp" + entry.getKey();
            vein.weight = layer.mWeight;
            vein.density = layer.mDensity;
            vein.size = layer.mSize;
            vein.heightRange = layer.mMinY + "-" + layer.mMaxY;
            vein.dim = EVERGLADES_DIM;
            vein.dimAbbr = EVERGLADES_ABBR;
            vein.ores = new ArrayList<Map<String, Object>>();
            gtPlusPlus.core.material.Material[] materials = new gtPlusPlus.core.material.Material[] {
                layer.mPrimary, layer.mSecondary, layer.mBetween, layer.mSporadic
            };
            for (int index = 0; index < roles.length; index++) {
                gtPlusPlus.core.material.Material material = materials[index];
                if (material == null) {
                    continue;
                }
                if (index == 0) {
                    vein.name = material.getLocalizedName();
                }
                Map<String, Object> exportedMaterial = ctx.map();
                ctx.putIfPresent(exportedMaterial, "internalName", material.getUnlocalizedName());
                ctx.putIfPresent(exportedMaterial, "name", material.getLocalizedName());
                Map<String, Object> exportedLayer = ctx.map();
                exportedLayer.put("role", roles[index]);
                exportedLayer.put("material", exportedMaterial);
                ItemStack ore = null;
                try {
                    ore = material.getOre(1);
                } catch (Throwable ignored) {
                    // No ore registered for the material: the layer keeps its material only.
                }
                ctx.putIfPresent(exportedLayer, "ore", ctx.itemStack(ore));
                vein.ores.add(exportedLayer);
            }
            extras.add(vein);
        }
    }

    private static boolean containsIdentity(List<?> list, Object value) {
        for (Object item : list) {
            if (item == value) {
                return true;
            }
        }
        return false;
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
        List<String> dims = generatingDims(vein.allowedDimWithOrigNames);
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
    private List<String> generatingDims(Map<String, Boolean> allowed) {
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

    private void exportMiningSmallOres(
        List<Map<String, Object>> adapters, Map<String, Object> domain, MiningContext ctx) {
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
                List<String> dims = generatingDims(small.allowedDimWithOrigNames);
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
