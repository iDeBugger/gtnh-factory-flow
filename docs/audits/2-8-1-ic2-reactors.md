# IC2 reactors in 2.8.1

The machine audit marked `ic2-fluid-reactor` and `vacuum-reactor` "not checkable":
IC2 has no public source at either pack's version. This check compares the shipped
bytecode instead, plus every GT5U class and pack config the two cards read.

Outcome: **same**. Nothing the cards model differs between 2.8.1 and 2.9. No code change.
`src/lib/power/sources/ic2-reactors-version.test.ts` pins the 2.8.1 numbers and their 2.9 twins.

## Jars

The 2.8.1 manifest names IC2 `2.2.82a-experimental`. That is the asset's tag, not the
file: DreamAssemblerXXL `gtnh-assets.json` at commit `6757a3ff` (the last change before
the 2.8.1 manifest, 2025-10-19) maps that tag to `industrialcraft-2-2.2.828a-experimental.jar`.
The 2.9 manifest names `2.2.2.828`, which today's `gtnh-assets.json` maps to
`industrialcraft-2-2.2.828-experimental.jar`. The GTNH maven does not host either jar.

| Pack | File | Download | SHA-256 |
|---|---|---|---|
| 2.8.1 | industrialcraft-2-2.2.828a-experimental.jar | http://downloads.gtnewhorizons.com/Mods_for_Twitch/industrialcraft-2-2.2.828a-experimental.jar | `b15d922b746dbc20411dca6ecfe1a975d295acbfc81b7e754fe5a6d8488a79b6` |
| 2.9 | industrialcraft-2-2.2.828-experimental.jar | https://mediafilez.forgecdn.net/files/6833/54/industrialcraft-2-2.2.828-experimental.jar | `de1d4597972be036eccd1c3b37e9980c3c9d9cdb92f52df2bf470971873893f6` |

Each download matches the jar in a local install of that pack, byte for byte.

## IC2 classes

Both jars hold 1,977 files, 903 of them classes. All files hash the same except one:
`ic2/lang/en_US.properties`. The lang change only renames items: "Steel Plate" becomes
"Refined Iron Plate", and so on. Every class is identical, the reactor classes included:

| Class | SHA-256 (both jars) |
|---|---|
| ic2/core/block/reactor/block/BlockReactorAccessHatch | `e2f93d44245e2cc6e1fc25187214d374cefa4dc04983b928b17239f0d9f31ca2` |
| ic2/core/block/reactor/block/BlockReactorChamber | `cea21cdedc82489bc9e057997f4841935399785ac1203d43d88abf40850a1a10` |
| ic2/core/block/reactor/block/BlockReactorFluidPort | `7123f20a15b61182aa3053ca63ef0730b410272246b255b68650be9df983ba90` |
| ic2/core/block/reactor/block/BlockReactorRedstonePort | `e04f1036a4e3b369c40ce01dcce9468d794749024d5e988ae91a287c726fb3e8` |
| ic2/core/block/reactor/block/BlockReactorVessel | `72cc17f4d83a8102856a07b73ca56119eeeff8e38287c9af2b7f59190dce01e4` |
| ic2/core/block/reactor/container/ContainerNuclearReactor | `bffbc96b55d5cd1dd242578db377ae915b0a1af41f9fac9d52987f8e55951fdb` |
| ic2/core/block/reactor/container/ContainerReactorFluidPort | `1b95a79ea41830a8501cc5eece27e67d79f694c350b4e03131175d37890819c4` |
| ic2/core/block/reactor/gui/GuiNuclearReactor | `b955ca9d3b3036026610a6792e4c02995f1a21e3a8a1ca3ee8af1c962734cbad` |
| ic2/core/block/reactor/gui/GuiReactorFluidPort | `e6b926b2b9101ea0e4323b4ede35f7628618866bb92a78328203cb595897f9d7` |
| ic2/core/block/reactor/tileentity/TileEntityNuclearReactorElectric | `60e26d04aadd21d4100ce1a50332f0f35a0f6e121d2955f3308ab996d5109b29` |
| ic2/core/block/reactor/tileentity/TileEntityReactorAccessHatch | `67b8d9905707db39cad1ccf0b363397657d1785c833a351328f16bcaf9d87136` |
| ic2/core/block/reactor/tileentity/TileEntityReactorChamberElectric | `6f9c4c95354bf44a22bca6198fddee01e0cac2ef211a8982917c4cb262c12b18` |
| ic2/core/block/reactor/tileentity/TileEntityReactorChamberElectric$1 | `a2f1711ee5bb8e6f886a1bca392fcb5c0ada83be871ddae34ee185f76b532b5a` |
| ic2/core/block/reactor/tileentity/TileEntityReactorFluidPort | `85f18f0971f6146db5046911b7a1cbe3c3419738d09761f8617c2626bc171820` |
| ic2/core/block/reactor/tileentity/TileEntityReactorRedstonePort | `57507f1a4f2aa6dbce10105032e7d382c13cfdb5fdd1dc77d240ea0feb4259cc` |
| ic2/core/item/reactor/ItemReactorCondensator | `61c461ba7e334ba306cf6310584ab6b0eb4115711884b522ccc1137e995dbc3b` |
| ic2/core/item/reactor/ItemReactorHeatStorage | `c8e0c98b19d38095f570e5ef18203067f9c1152ce407742484e0912ccff46590` |
| ic2/core/item/reactor/ItemReactorHeatSwitch | `7b2562f758422e8f21c243c13e6f547d5a641fb0c6f840ff4e955b5f368e2c5c` |
| ic2/core/item/reactor/ItemReactorHeatSwitch$ItemStackCoord | `df790f64e5b7d732c6b340d4f5d2c08c47b83246d47ab893a17356e1f570fd18` |
| ic2/core/item/reactor/ItemReactorLithiumCell | `e21aa29a0ec7274983d660fdc0c4d87b971fef1a0cc71a231d3216baac8a09eb` |
| ic2/core/item/reactor/ItemReactorMOX | `900e8682e19956ff461ea39fbf55c2995492850c2450e51ea0cf252b31be6380` |
| ic2/core/item/reactor/ItemReactorPlating | `5266bfd06aa8660ecf10c03dedd81846cc40da4671ce54c380f69f910e45ab0f` |
| ic2/core/item/reactor/ItemReactorReflector | `61a8c61822139db13f5716766c385e3a8325026b236b129b7d28337eab6abb1d` |
| ic2/core/item/reactor/ItemReactorUranium | `8960bf80107172ab4becc113ef555fc2cd9920311767212d02e394d81f287547` |
| ic2/core/item/reactor/ItemReactorUranium$ItemStackCoord | `338072c31adabafaa0b22a56f66df90b74789f61fac7ac9c148e865d1a4bf957` |
| ic2/core/item/reactor/ItemReactorVent | `27665189abea72f07b6392599307dc7c19a063108be9d4a303d5a07d866e36bd` |
| ic2/core/item/reactor/ItemReactorVentSpread | `7e1ac4ba96adcbc8139204f43190941079b80a1bb4159cb6e07e66c6fe6dfa14` |

No class differs, so there was nothing to decompile.

## GT5U rods and coolant cells

The vacuum reactor card reads its rods and cells from GT5U, not IC2. Compared at
5.09.51.476 (2.8.1) and 5.09.54.205 (2.9):

- `gregtech/api/items/ItemRadioactiveCellIC.java` is the same file at both tags,
  SHA-256 `55d646bc085058fb608d167ba8bc54c0a9b043690c66445add88ccba73b37003`.
  It holds `processChamber`, the pulse, heat and MOX rules.
- `gregtech/api/items/ItemCoolantCellIC.java` is the same file at both tags,
  SHA-256 `a60f94858c249b0d5b3c62f560d099134b614e99a1ee51a9b607fe444325d470`.
- `ItemDepletedCell` and `ItemNeutronReflector` are the same. `ItemBreederCell` only
  swaps a number-format import. Breeder cells are not on either card.
- `gregtech/loaders/preload/LoaderGTBlockFluid.java` builds 78 reactor items: 31 fuel
  rods, 33 depleted rods, 11 coolant cells, the Iridium Neutron Reflector and 2 breeder
  cells. They run from the reflector to the quad Tiberium rod, lines 200 to 721 at
  5.09.51.476 and 211 to 732 at 5.09.54.205, and nothing else is built in that span. The
  Nuclear Control sensor cards just before it (5.09.51.476 :187-198, 5.09.54.205 :198-209)
  are not reactor items and are not compared. With whitespace collapsed, every reactor
  constructor call is the same at both tags, the quad naquadah rod's `sHeat 1F` included.
  Both lists hash to `49300d7aca42728d44c196837cd7bb6f000e4329340b3fc3a09cc2ee5c24ecee`.
  No other file builds a rod or cell.

## Pack config

`config/IC2.ini` in GT-New-Horizons-Modpack is the same file at tags `2.8.1`, `2.9.0-RC-2`
and `2.9.0-nightly-2026-10-04` (the 2.9 manifest's config),
SHA-256 `d4196a124698c0951a94cc7a798134bb8803d000ace816b6ca57334dfe9dd11f`.
It sets `nuclear = 5.0` (the card's 25 EU per rod energy) and FluidReactor
`outputModifier = 1.0`.

## Dataset names

All 78 item and fluid names the two cards emit resolve through
`src/lib/power/data/resource-map.json` to an id. Each id is in both
`local-2.8.1/resource-index.json.gz` and `local-2.9.0-rc-2/resource-index.json.gz`.
The names are Coolant, Hot Coolant, 30 fuel rods, 30 depleted rods, The Core and its
depleted form, and the 14 coolant cells.

## What the cards' numbers rest on

- **Fluid reactor.** The three design rates, 1150, 1380 and 1340 L/s of coolant, are the
  workbook's design table. They were not re-derived from the game. The check above shows
  only that nothing they rest on changed between the packs, so the same table holds for
  both. `ic2-reactors-version.test.ts` pins the table's values, not game-derived ones.
- **Vacuum reactor.** The numbers come from `ItemRadioactiveCellIC.processChamber` and the
  rod constructors. For the quad uranium rod (4 cells, sEnergy 2, sHeat 4):
  - pulses per cell p = 1 + 4 / 2 = 3, so a rod with n rod neighbours pulses 3 + n times;
  - heat a second from one rod is (p + n)(p + n + 1) x sHeat x cells / 2 = 8 (3 + n)(4 + n):
    160 for one neighbour, 240 for two, 336 for three;
  - the layout has 4 rods with one neighbour, 14 with two and 22 with three, so the 14
    coolant cells take 4 x 160 + 14 x 240 + 22 x 336 = 11,392 a second, 11,392 / 14 = 813.71
    on average;
  - the hottest cell sits beside four three-neighbour rods: 4 x 336 = 1,344 a second;
  - EU: each pulse is sEnergy x 25 = 50 EU (IC2's x5 times IC2.ini `nuclear = 5.0`), so
    4 cells x (4 x 4 + 14 x 5 + 22 x 6) pulses x 50 = 43,600 EU/t.

## Verdicts

| Item | Verdict | Source |
|---|---|---|
| ic2-fluid-reactor | same | IC2 2.2.828a-experimental and 2.2.828-experimental have identical class files (above), and IC2.ini is the same at both pack tags. The card's design rates are the workbook's table, not re-derived from the game; nothing they rest on changed. |
| vacuum-reactor | same | the IC2 classes above, GT5U ItemRadioactiveCellIC and ItemCoolantCellIC unchanged, LoaderGTBlockFluid 5.09.51.476:200-721 the same rod and cell list as 5.09.54.205:211-732, and IC2.ini `nuclear = 5.0` at both tags |

Nothing is left for an in-game check.
