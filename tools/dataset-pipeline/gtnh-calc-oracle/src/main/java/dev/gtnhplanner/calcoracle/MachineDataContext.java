package dev.gtnhplanner.calcoracle;

import net.minecraft.item.ItemStack;
import net.minecraftforge.fluids.FluidStack;

import java.util.Map;

/**
 * The exporter helpers MachineDataExport needs, so its ids are the ones the rest of the
 * export writes. itemId and fluidId return the id only: they never capture an icon, so the
 * machine data cannot add to or reorder the rendered icons.
 */
public interface MachineDataContext {
    String itemResourceId(String registryId, int meta);

    String canonicalRegistryId(String registryId);

    Map<String, Object> map();

    String safeString(Object value);

    String itemId(ItemStack stack);

    String fluidId(FluidStack stack);
}
