package dev.gtnhplanner.calcoracle;

import net.minecraft.block.Block;
import net.minecraft.entity.Entity;
import net.minecraft.init.Blocks;
import net.minecraft.profiler.Profiler;
import net.minecraft.world.World;
import net.minecraft.world.WorldProvider;
import net.minecraft.world.WorldSettings;
import net.minecraft.world.chunk.IChunkProvider;
import net.minecraft.world.storage.ISaveHandler;

import java.lang.reflect.Field;
import java.util.Random;

/**
 * The world a simulated crop tile reports while the oracle samples a crop's drops. The
 * export runs at the main menu, where no world exists, and some crops read one in getGain
 * (IC2 Red Wheat checks for a redstone signal and rolls the world's random; Mana Bean looks
 * for a crystal cluster under it). Every block is air, and the redstone answer is whatever
 * the sample asks for; the crop asking is recorded so the exporter can sample it powered.
 * Any other world call meets null internals and fails as it would with no world at all.
 *
 * The instance is allocated without running World's constructor, which needs a save
 * handler and a chunk provider the oracle does not have.
 */
final class OracleCropWorld extends World {
    boolean powered;
    boolean powerAsked;

    private OracleCropWorld() {
        super((ISaveHandler) null, (String) null, (WorldProvider) null, (WorldSettings) null, (Profiler) null);
    }

    static OracleCropWorld create() {
        try {
            Field unsafeField = Class.forName("sun.misc.Unsafe").getDeclaredField("theUnsafe");
            unsafeField.setAccessible(true);
            Object unsafe = unsafeField.get(null);
            Object world = unsafe.getClass().getMethod("allocateInstance", Class.class).invoke(unsafe, OracleCropWorld.class);
            OracleCropWorld cropWorld = (OracleCropWorld) world;
            cropWorld.rand = new Random();
            return cropWorld;
        } catch (Throwable ignored) {
            return null;
        }
    }

    @Override
    public Block getBlock(int x, int y, int z) {
        return Blocks.air;
    }

    @Override
    public boolean isAirBlock(int x, int y, int z) {
        return true;
    }

    @Override
    public int getBlockMetadata(int x, int y, int z) {
        return 0;
    }

    @Override
    public boolean isBlockIndirectlyGettingPowered(int x, int y, int z) {
        powerAsked = true;
        return powered;
    }

    @Override
    protected IChunkProvider createChunkProvider() {
        return null;
    }

    @Override
    protected int func_152379_p() {
        return 0;
    }

    @Override
    public Entity getEntityByID(int id) {
        return null;
    }
}
