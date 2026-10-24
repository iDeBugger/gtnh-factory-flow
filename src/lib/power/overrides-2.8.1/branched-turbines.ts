/** Turbine source ids whose 2.8.1 builder branch changes the source itself, not just its tables. */
export const BRANCHED_TURBINES_2_8_1: string[] = [
  // GT5U@5.09.51.476 goodgenerator/blocks/tileEntity/MTESupercriticalFluidTurbine.java:77
  "large-sc-steam-turbine",
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/production/turbines/MTELargeTurbineSteam.java:124
  "xl-turbo-steam-turbine",
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/production/turbines/MTELargeTurbineSHSteam.java:115
  "xl-turbo-hp-steam-turbine",
  // GT5U@5.09.51.476 gtPlusPlus/xmod/gregtech/common/tileentities/machines/multi/production/turbines/MTELargeTurbineSCSteam.java:101
  "xl-turbo-sc-steam-turbine",
  // The dynamo hatch list: 2.8.1 adds the 2A wireless dynamos (GT5U@5.09.51.476
  // gregtech/api/metatileentity/implementations/MTEWirelessDynamo.java:75-77) and has 4A dynamos only to UHV,
  // GT++'s buffered ones (TecTech MTEHatchDynamoMulti.java:29 extends MTEHatch there).
  "large-steam-turbine",
  "large-hp-steam-turbine",
  "large-gas-turbine",
  "large-plasma-generator",
];
