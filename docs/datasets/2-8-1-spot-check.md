# GTNH 2.8.1 dataset spot check

The 2.8.1 dataset (`local-2.8.1`) checked against the mod sources at the 2.8.1 pack's tags, with a few rows on the 2.9
dataset (`local-2.9.0-rc-2`) where the feature belongs to it. The last column is for the owner to fill in after checking in game.

Sources, at the jar versions in the 2.8.1 pack:

- GT5U `GTNewHorizons/GT5-Unofficial@5.09.51.476` (GT++, bartworks and GTNEIOrePlugin are inside it). For 2.9 rows:
  `@5.09.54.205`.
- NH Core Mod `GTNewHorizons/NewHorizonsCoreMod@2.7.262`.
- CropsPP `GTNewHorizons/Crops-plus-plus@1.8.11`.
- IC2 `industrialcraft-2-2.2.828a-experimental.jar` from the pack. It has no public source, so the row cites the
  disassembled method.

The dataset value is what the recipe search shows: an amount per craft or per harvest, a time in ticks, and EU/t.
"2.9 id" says whether the same recipe id is in the 2.9 dataset.

## Rows

| item | expected (repo@tag file:line) | dataset value | match | owner confirmed in game |
|---|---|---|---|---|
| GT: Raw Silicon Ingot (EBF) | GT5U@5.09.51.476 `gregtech/loaders/postload/recipes/BlastFurnaceRecipes.java:223-231`: 3 SiO2 dust + 2 carbon dust, 1 silicon ingot + ash 11.11%, 2000 L CO, 4 s, MV (120), coil 1200 K | `oracle:gregtech:gt-recipe-blastfurnace:c7dfbb47010378b1`: Silicon Dioxide Dust x3, Carbon Dust x2, Raw Silicon Ingot x1, Ashes x1 @0.1111, Carbon Monoxide 2000 L, 80 t, 120 EU/t, heat 1200. 2.9 id: no, differs (below) | yes | |
| GT: Epichlorohydrin from HClO (Chemical Reactor) | GT5U@5.09.51.476 `gregtech/loaders/postload/recipes/ChemicalRecipes.java:2003-2010`: HClO cell + 3 NaOH dust + 1000 L allyl chloride, salt water cell + 1000 L epichlorohydrin, 24 s, LV | `oracle:gregtech:gt-recipe-chemicalreactor:2f2f7e5df8b6f379`: Hypochlorous Acid Cell x1, Sodium Hydroxide Dust x3, Allyl Chloride 1000 L, Salt Water Cell x1, Epichlorohydrin 1000 L, 480 t, 30 EU/t. 2.9 id: same | yes | |
| GT: Platinum Group Sludge (Centrifuge) | GT5U@5.09.51.476 `gregtech/loaders/postload/recipes/CentrifugeRecipes.java:57-68`: 3 PGS dust, 3 SiO2, 3 Au, 3 Pt, 1 Pd @95%, 1 Ir @90%, 1 Os @85%, 135 s, 30 EU/t. Then bartworks rewrites the platinum outputs at load: `bartworks/system/material/gtenhancement/PlatinumSludgeOverHaul.java:925` (Pt dust to Platinum Metallic Powder x2), `:948` (Pd to Palladium Metallic Powder x4), `:977` (Os to Rarest Metal Residue x1), `:1006` (Ir to Iridium Metal Residue x1); names `bartworks/system/material/WerkstoffLoader.java:1131-1145` | `oracle:gregtech:gt-recipe-centrifuge:55d506c30424e8f1`: Silicon Dioxide Dust x3, Gold Dust x3, Platinum Metallic Powder Dust x6, Palladium Metallic Powder Dust x4 @0.95, Iridium Metal Residue Dust x1 @0.9, Rarest Metal Residue Dust x1 @0.85, 2700 t, 30 EU/t. 2.9 id: differs | yes (the runtime rewrite, as the game runs it) | |
| GT++: Acetic Anhydride (Chemical Plant) | GT5U@5.09.51.476 `gtPlusPlus/xmod/gregtech/loaders/recipe/RecipeLoaderGlueLine.java:60-69`: circuit 17, Blue Metal Catalyst (not used up), 1000 L CO + 1000 L methyl acetate, 1000 L acetic anhydride, 10 s, HV (480), casing tier 3 | `oracle:gregtech:gt-recipe-fluidchemicaleactor:948e8b4d94e08d4d`: Programmed Circuit (not used up), Blue Metal Catalyst (not used up), Carbon Monoxide 1000 L, Methyl Acetate 1000 L, Acetic Anhydride 1000 L, 200 t, 480 EU/t, special value 3. 2.9 id: same | yes | |
| GT++: Cyanoacetic Acid (Chemical Plant) | GT5U@5.09.51.476 `gtPlusPlus/xmod/gregtech/loaders/recipe/RecipeLoaderGlueLine.java:84-97`: circuit 19, 6 Na2CO3 dust, 3 NaCN dust, 1000 L chloroacetic acid, 2000 L HCl, 9 cyanoacetic acid dust + 6 salt, 1000 L CO2 + 1000 L water, 20 s, 1000 EU/t, casing tier 4 | `oracle:gregtech:gt-recipe-fluidchemicaleactor:4adcabd353918f0e`: those inputs and outputs, 400 t, 1000 EU/t, special value 4. 2.9 id: same | yes | |
| GT++: LFTR sparging, the 3 recipes | GT5U@5.09.51.476 `gtPlusPlus/xmod/gregtech/loaders/recipe/RecipeLoaderLFTR.java:110-153`: 1000 L He + 50 L U salt (max byproduct 200); 100 L F + 50 L T salt (max 10); 100 L F + 50 L TB salt (max 20); each 25 s, IV. The tower rolls each byproduct 1 to max and returns the rest of the gas: `gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/processing/MTESpargeTower.java:178-191`, so the average is (1 + max) / 2 per byproduct | `...:gt-recipe-lftr-sparging:650708c28717513c` (U salt): 5 noble gases x100.5 each, Helium 497.5 L back. `...:1e05555dde136f97` (T salt): 5 fluorides x5.5, Fluorine 72.5 L. `...:e8b5aaec6e5cc6a4` (TB salt): 5 fluorides about 10.5, Fluorine 47.5 L. All 500 t, 7680 EU/t, sparged salt 50 L. 2.9 ids: same | yes | |
| Crafting: EnderIO Stirling Generator (shaped) | NHCoreMod@2.7.262 `com/dreammaster/scripts/ScriptEnderIO.java:208-218`: itemCasingAnyIron, circuitBasic, itemCasingAnyIron / rotorIron, Machine Chassis, rotorIron / LV motor, craftingIronFurnace, LV motor | `oracle:crafting:shaped:8d7614c638f61b4d`: the same nine cells in that order (ore dictionary cells keep their names), 1 Stirling Generator. 2.9 id: differs | yes | |
| Crafting: Glass Pane (shapeless) | NHCoreMod@2.7.262 `com/dreammaster/scripts/ScriptMinecraft.java:1910`: craftingToolSaw + glass, 2 glass panes | `oracle:crafting:shapeless:fefb9b3f3dc2c9b0`: Ore Dictionary craftingToolSaw x1, Ore Dictionary glass x1, Glass Pane x2. 2.9 id: same | yes | |
| Thaumcraft arcane: Alchemical Boiler | NHCoreMod@2.7.262 `com/dreammaster/scripts/ScriptAutomagy.java:88-104`: research ALCHEMYBOILER, 25 aqua, 20 ignis, 20 ordo, grid SAS / TFT / SBS (S arcane stone bricks, A high-pressure boiler tank, T plateThaumium, F blast furnace, B tank) | `oracle:thaumcraft:arcane:652b31c2644effb9`: Arcane Stone Bricks, High Pressure Boiler Tank, Arcane Stone Bricks / plateThaumium, Blast Furnace, plateThaumium / Arcane Stone Bricks, Tank, Arcane Stone Bricks, Aqua 25, Ignis 20, Ordo 20, research ALCHEMYBOILER. 2.9 id: same | yes | |
| Thaumcraft arcane: Redstone Inversion Torch | NHCoreMod@2.7.262 `ScriptAutomagy.java:105-121`: research REDSTONETHEORY, 10 ordo, grid with b, d, f, h Sliver of Order and e redstone torch (a plus shape) | `oracle:thaumcraft:arcane:b577bf00eab1bb09`: 4 Sliver of Order and a Redstone Torch in a plus (NEI slots top, left, centre, right, bottom), Ordo 10. 2.9 id: same | yes | |
| Thaumcraft arcane: Hourglass | NHCoreMod@2.7.262 `ScriptAutomagy.java:127-151`: research REDSTONETHEORY, 15 ordo, 10 perditio, grid ringGold, oak plank, screwGold / Genetics misc:8, dustQuartzSand, Genetics misc:8 / screwGold, oak plank, ringGold | `oracle:thaumcraft:arcane:f9d0e608543b3224`: ringGold, Oak Plank, screwGold / Glass Cylinder, dustQuartzSand, Glass Cylinder / screwGold, Oak Plank, ringGold, Ordo 15, Perditio 10. 2.9 id: same | yes | |
| Thaumcraft infusion: Infused Gold Ingot | NHCoreMod@2.7.262 `ScriptAutomagy.java:607-618`: research InfusedGoldGTNH, instability 2, 16 lucrum, 12 metallum, 8 ordo, 4 praecantatio, 4 aer, gold ingot centre, 4 thaumium dust | `oracle:thaumcraft:infusion:dcb81d3e72c20ec6`: Gold Ingot, Thaumium Dust x4 (four slots), those aspects, instability 2. 2.9 id: same | yes | |
| Bee: Coal | GT5U@5.09.51.476 `gregtech/loaders/misc/GTBeeDefinition.java:192-194`: product Lignite Comb 0.30, specialty Coal Comb 0.15 | `oracle:forestry-bee:gregtech-bee-speciescoal`: Lignite Comb @0.30, Coal Comb @0.15 | yes | |
| Vein: Magnetite | GT5U@5.09.51.476 `gregtech/api/enums/OreMixes.java:64-74`: y 60-180, weight 160, density 2, size 32, OW, Twilight Forest, Seth, BarnardE, Ceres, Deimos, Io, MakeMake, TcetiE; primary and secondary Magnetite, between Iron, sporadic Vanadium Magnetite | `oracle:ore-vein:ore-mix-magnetite`: heightRange 60-180, weight 160, density 2, size 32, the same 9 dimensions, layers Magnetite, Magnetite, Iron, Vanadium Magnetite | yes | |
| Vein: Quartzite (one of the identity veins) | GT5U@5.09.51.476 `gregtech/api/enums/OreMixes.java:338-348`: y 80-120, weight 20, density 2, size 16, Nether and Neper; Quartzite, Barite, Certus Quartz, Certus Quartz | `oracle:ore-vein:ore-mix-quartz`: 80-120, weight 20, density 2, size 16, Nether and Neper, layers Quartzite, Barite, Certus Quartz, Certus Quartz | yes | |
| Vein (2.9): Graphite, Ross128b (one of the 2.9 identity veins) | GT5U@5.09.54.205 `gregtech/api/enums/OreMixes.java:1362-1371`: y 5-25, weight 5, density 4, size 12, Ross128b; Graphite, Diamond, Coal, Graphite | 2.9 `oracle:ore-vein:ore-mix-ross128-carbon`: 5-25, weight 5, density 4, size 12, Ross128b, those layers | yes | |
| Vein (2.8.1): Graphite, Ross128b (bartworks) | GT5U@5.09.51.476 `bartworks/system/oregen/BWWorldGenRoss128b.java:85`: y 5-25, weight 5, density 4, size 12, Ross128b; Graphite, Diamond, Coal, Graphite | `oracle:ore-vein:ore-mix-ross128-carbon`: 5-25, weight 5, density 4, size 12, Ross128b, those layers. 2.9 id: same | yes | |
| Vein (2.8.1): Agardite (Nd), Toxic Everglades | GT5U@5.09.51.476 `toxiceverglades/gen/WorldGenEvergladesOres.java:38-48`: weight 30, density 2, size 16; Agardite (Nd), Agardite (Y), Kashinite, Cerite. The y 0-60 it is given is not used: every 2.8.1 layer sets y 5-14 (`toxiceverglades/gen/WorldGenEvergladesOreLayer.java:88-89`). It is number 2 in `validOreveins` (`WorldGenEvergladesOres.java:253-275`), the number 2.9 names it by | `oracle:ore-vein:ore-mix-gtpp2`: 5-14, weight 30, density 2, size 16, dimensionDarkWorld (Eg), those layers. 2.9 id: same (2.9 gives it y 0-60) | yes | |
| IC2 crop: Red Stonelilly on Red Granite (block need) | CropsPP@1.8.11 `crops/gregtechCrops/StonelillyCrop.java:63` (needs stoneGraniteRed or blockGranite below to mature), `:115` (9 Red Granite dust a drop on stoneGraniteRed), `:116` (1 granite block on blockGranite) | `oracle:ic2-crop:berriespp:35:under-stonegranitered`: Red Granite Dust x22.58 a harvest, note "Needs Red Granite under it"; `...:35:under-blockgranite`: Granite x3.20. 22.58 / 3.20 = 9.32 / 1.32, which is 9 and 1 items a drop with the gain bonus | yes | |
| IC2 crop: Redwheat, with and without a redstone signal (2.8.1 and 2.9) | IC2 2.2.828a `ic2/core/crop/CropRedWheat.getGain` (disassembled): powered (`World.isBlockIndirectlyGettingPowered`) gives 1 redstone; otherwise `nextBoolean` picks 1 redstone or 1 wheat | `oracle:ic2-crop:ic2:15`: Redstone Dust x0.839 + Wheat x0.839; `oracle:ic2-crop:ic2:15:redstone-signal`: Redstone Dust x1.677, note "Needs a redstone signal". The same on both versions, same ids | yes | |
| IC2 crop: Tearstalks (GT crop) | GT5U@5.09.51.476 `gregtech/loaders/postload/CropLoader.java:336-354`: id 140, tier 8, drop 1 ghast tear | `oracle:ic2-crop:gregtech:140`: tier 8, Ghast Tear x2.23 a harvest. 2.9: no such id (2.9's GT crops are CropsNH) | yes | |
| Tree Growth Simulator: Spruce (2.8.1 machine data) | GT5U@5.09.51.476 `gtPlusPlus/xmod/gregtech/loaders/recipe/RecipeLoaderTreeFarm.java:46-57`: Oak log 1, Spruce log 2, no fruit for Spruce | `src/lib/machines/data/2.8.1/tgs-trees.json`: Oak log 5, Spruce log 10, sapling 5, leaves 2, no fruit (the NEI recipes' amounts, the same factor of 5 on both) | yes | |

## A recipe that differs between 2.8.1 and 2.9

**Raw Silicon Ingot in the Electric Blast Furnace.**

| | 2.8.1 | 2.9 |
|---|---|---|
| id | `oracle:gregtech:gt-recipe-blastfurnace:c7dfbb47010378b1` | `oracle:gregtech:gt-recipe-blastfurnace:68b67d723eb95e92` |
| time | 80 t (4 s) | 400 t (20 s) |
| source | GT5U@5.09.51.476 `BlastFurnaceRecipes.java:228` `.duration(4 * SECONDS)` | GT5U@5.09.54.205 `BlastFurnaceRecipes.java:237` `.duration(20 * SECONDS)` |

Both versions have the same inputs (3 Silicon Dioxide Dust, 2 Carbon Dust), the same outputs (Raw Silicon Ingot, Ashes
@0.1111, 2000 L Carbon Monoxide), 120 EU/t and heat 1200. Only the time differs. Ten other EBF recipes also have a
different id on each version, with the same name and one recipe each, for example Carbon Plate (`ef3e773718029f4c`
and `9126dee1a669318c`). About half of the EBF names have the same single recipe and the same id on both versions
(150 of the names that hold one recipe on both).

## Mismatches

None. The 2.8.1 dataset has 117 veins: the 79 of GT's `OreMixes`, 10 Ross128b and 8 Ross128ba veins from bartworks'
`BWOreLayer.sList`, and 20 Toxic Everglades veins from `WorldGenEvergladesOreLayer.sList`. In 2.9 all of them are in
`OreMixes`. Neither version has a Ross128 small ore.

The Everglades veins differ between the versions in two ways. On 2.8.1 every one generates at y 5-14, on 2.9 at the
height each vein names. The base Iron vein (`ore-mix-gtpp0`) places vanilla Iron Ore on 2.8.1 and GregTech Iron Ore on
2.9.

## For the owner to check in game (2.8.1)

1. EBF Raw Silicon Ingot takes 4 s (80 t) at 120 EU/t, heat 1200.
2. Centrifuge, 3 Platinum Group Sludge Dust: 6 Platinum Metallic Powder Dust, 4 Palladium Metallic Powder Dust at 95%,
   1 Iridium Metal Residue at 90%, 1 Rarest Metal Residue at 85%, 135 s.
3. Chemical Plant Acetic Anhydride: 10 s, 480 EU/t, casing tier 3.
4. Sparge Tower, Helium on U Salt: about 100 L of each noble gas a run (1 to 200 at random), the rest of the 1000 L
   helium back.
5. Arcane Workbench, Redstone Inversion Torch: 4 Slivers of Order in a plus round a redstone torch, 10 Ordo.
6. Infusion, Infused Gold Ingot: instability 2 and the five aspects above.
7. Magnetite vein: y 60 to 180, on the 9 dimensions above.
8. Red Stonelilly on Red Granite drops 9 Red Granite Dust a drop; on (non-GT) Granite it drops a granite block.
9. Redwheat with a redstone signal drops only redstone; without one, half redstone and half wheat.
10. Ross128b Graphite vein: y 5 to 25, Graphite, Diamond, Coal and Graphite.
11. Toxic Everglades Agardite (Nd) vein: its ore blocks sit at about y 4 to 13, never up to y 60.
12. Tree Growth Simulator, Spruce sapling: 10 logs a cycle in log mode at the base tier, the same as the NEI recipe.
