package dev.gtnhplanner.calcoracle.icons;

import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.awt.Graphics2D;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.lang.reflect.Array;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.imageio.ImageIO;
import javax.imageio.stream.MemoryCacheImageOutputStream;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.FontRenderer;
import net.minecraft.client.gui.GuiScreen;
import net.minecraft.client.renderer.RenderHelper;
import net.minecraft.client.renderer.RenderBlocks;
import net.minecraft.client.renderer.OpenGlHelper;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.client.renderer.entity.RenderItem;
import net.minecraft.client.shader.Framebuffer;
import net.minecraft.item.Item;
import net.minecraft.item.ItemStack;
import net.minecraftforge.client.ForgeHooksClient;
import net.minecraftforge.oredict.OreDictionary;
import org.lwjgl.BufferUtils;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL12;
import org.lwjgl.opengl.GL20;

public final class ClientItemStackIconRenderer {

    private static final int ICON_SIZE = Integer.getInteger("gtnh.oracle.iconSize", 256);
    private static final int GUI_ICON_CANVAS_SIZE = 32;
    private static final int GUI_ITEM_SIZE = 16;
    private static final int ICON_EXPORT_BATCH_SIZE = Integer.getInteger("gtnh.oracle.iconExportBatchSize", 64);
    private static final int ICON_PROGRESS_EVERY = Integer.getInteger("gtnh.oracle.iconProgressEvery", 256);
    private static final int MAX_RENDER_WARNINGS = Integer.getInteger("gtnh.oracle.maxIconRenderWarnings", 50);
    // PNG encoding took three quarters of the render thread's time; it runs on these threads instead, while the
    // render thread only draws and reads pixels back.
    // Icons drawn before their pixels are read back together.
    private static final int READ_BACK_BATCH = Integer.getInteger("gtnh.oracle.iconReadBackBatch", 64);
    private static final int ICON_ENCODE_THREADS = Integer.getInteger(
        "gtnh.oracle.iconEncodeThreads",
        Math.max(1, Runtime.getRuntime().availableProcessors() - 1)
    );
    private static final Map<String, String> ICONS_BY_STACK_KEY = new LinkedHashMap<String, String>();
    private static final Map<String, ItemStack> PENDING_STACKS_BY_KEY = new LinkedHashMap<String, ItemStack>();
    private static final RenderItem RENDER_ITEM = new RenderItem();
    private static final RenderBlocks RENDER_BLOCKS = new RenderBlocks();
    private static int renderWarnings;

    private ClientItemStackIconRenderer() {}

    public static String lookupIcon(ItemStack stack) {
        return captureIcon(stack);
    }

    public static String captureIcon(ItemStack stack) {
        if (stack == null || stack.getItem() == null || stack.stackSize <= 0) {
            return null;
        }

        String key = stackKey(stack);
        if (ICONS_BY_STACK_KEY.containsKey(key)) {
            String value = ICONS_BY_STACK_KEY.get(key);
            return value != null && value.length() > 0 ? value : null;
        }

        try {
            ItemStack renderStack = renderableStack(stack);
            String renderKey = stackKey(renderStack);
            String filename = existingIconFilename(renderKey);
            if (filename == null) {
                filename = safeName(renderStack) + "-" + sha1(renderKey).substring(0, 12) + ".png";
                ICONS_BY_STACK_KEY.put(renderKey, filename);
                PENDING_STACKS_BY_KEY.put(renderKey, renderStack);
            }
            ICONS_BY_STACK_KEY.put(key, filename);
            return filename;
        } catch (Throwable t) {
            ICONS_BY_STACK_KEY.put(key, "");
            warnRenderFailure(stack, t);
            return null;
        }
    }

    private static ItemStack renderableStack(ItemStack stack) {
        ItemStack renderStack = stack.copy();
        renderStack.stackSize = 1;
        if (renderStack.getItemDamage() == OreDictionary.WILDCARD_VALUE) {
            renderStack.setItemDamage(0);
        }
        return renderStack;
    }

    private static String existingIconFilename(String key) {
        if (!ICONS_BY_STACK_KEY.containsKey(key)) {
            return null;
        }
        String value = ICONS_BY_STACK_KEY.get(key);
        return value != null && value.length() > 0 ? value : null;
    }

    public static void exportRegistryIconsThen(Runnable afterExport) {
        Minecraft minecraft = Minecraft.getMinecraft();
        if (minecraft == null) {
            afterExport.run();
            return;
        }

        GtnhCalcOracleMod.LOG.info("GTNH 1.7.10 icon exporter is ready for on-demand ItemStack rendering.");
        minecraft.displayGuiScreen(new IconExportScreen(afterExport));
    }

    public static void exportQueuedIconsThen(Runnable afterExport) {
        Minecraft minecraft = Minecraft.getMinecraft();
        if (minecraft == null) {
            afterExport.run();
            return;
        }

        minecraft.displayGuiScreen(new QueuedIconExportScreen(afterExport));
    }

    /**
     * Icons draw one after another into framebuffers of their own, reused, and are read back together once the batch
     * is drawn: reading each icon back straight after drawing it kept the render thread waiting on the rasterizer
     * half its time. Each framebuffer is drawn exactly as a lone icon's was, at the origin, so the pixels are the same;
     * drawing the batch side by side into one large framebuffer moved the edges of 3D blocks by a pixel.
     */
    private static final class IconGrid {

        private final Framebuffer[] framebuffers = new Framebuffer[READ_BACK_BATCH];
        private ByteBuffer readBuffer;
        private int used;

        int free() {
            return READ_BACK_BATCH - used;
        }

        /** Draws the stack into the next framebuffer and returns its index. */
        int draw(ItemStack stack) throws Exception {
            int slot = used++;
            if (framebuffers[slot] == null) {
                framebuffers[slot] = new Framebuffer(ICON_SIZE, ICON_SIZE, true);
            }
            renderStackIntoFramebuffer(stack, framebuffers[slot]);
            return slot;
        }

        /** Every drawn icon's pixels, bottom row first, as glReadPixels gives them; empties the batch. */
        byte[][] readBack() {
            byte[][] slots = new byte[used][];
            if (readBuffer == null) {
                readBuffer = BufferUtils.createByteBuffer(ICON_SIZE * ICON_SIZE * 4);
            }
            for (int slot = 0; slot < used; slot++) {
                framebuffers[slot].bindFramebuffer(false);
                try {
                    readBuffer.clear();
                    GL11.glReadPixels(0, 0, ICON_SIZE, ICON_SIZE, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, readBuffer);
                } finally {
                    framebuffers[slot].unbindFramebuffer();
                }
                byte[] pixels = new byte[ICON_SIZE * ICON_SIZE * 4];
                readBuffer.get(pixels);
                slots[slot] = pixels;
            }
            used = 0;
            return slots;
        }
    }

    /** Draws the stack into a framebuffer of the batch: the part of an icon that needs the GL thread. */
    private static void renderStackIntoFramebuffer(ItemStack stack, Framebuffer framebuffer) throws Exception {
        Minecraft minecraft = Minecraft.getMinecraft();
        if (minecraft == null || minecraft.getTextureManager() == null) {
            throw new IllegalStateException("Minecraft client is not ready.");
        }

        boolean projectionPushed = false;
        boolean modelViewPushed = false;
        // A renderer that throws part way (GT items reading the player in a main-menu export) leaves its GL state
        // behind: every icon after it came out as a dark silhouette in the RC-2 export. Each render gets its state
        // back as the first icon found it: matrix stacks, shader program, texture units and the switches item rendering
        // uses. Not with glPushAttrib: a renderer that pushed its own and threw would leave every later pop one short.
        final int modelViewDepth = GL11.glGetInteger(GL11.GL_MODELVIEW_STACK_DEPTH);
        final int projectionDepth = GL11.glGetInteger(GL11.GL_PROJECTION_STACK_DEPTH);
        saveGlStateOnce();
        applySavedGlState();
        resetLibraryRenderState();

        try {
            resetTessellator();
            framebuffer.bindFramebuffer(true);

            GL11.glViewport(0, 0, ICON_SIZE, ICON_SIZE);
            GL11.glClearColor(0.0F, 0.0F, 0.0F, 0.0F);
            GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);

            GL11.glMatrixMode(GL11.GL_PROJECTION);
            GL11.glPushMatrix();
            projectionPushed = true;
            GL11.glLoadIdentity();
            GL11.glOrtho(0.0D, GUI_ICON_CANVAS_SIZE, GUI_ICON_CANVAS_SIZE, 0.0D, 1000.0D, 3000.0D);

            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            GL11.glPushMatrix();
            modelViewPushed = true;
            GL11.glLoadIdentity();
            GL11.glTranslatef(0.0F, 0.0F, -2000.0F);

            RenderHelper.enableGUIStandardItemLighting();
            GL11.glEnable(GL12.GL_RESCALE_NORMAL);
            FontRenderer fontRenderer = stack.getItem().getFontRenderer(stack);
            if (fontRenderer == null) {
                fontRenderer = minecraft.fontRenderer;
            }
            int itemX = (GUI_ICON_CANVAS_SIZE - GUI_ITEM_SIZE) / 2;
            int itemY = (GUI_ICON_CANVAS_SIZE - GUI_ITEM_SIZE) / 2;
            if (
                !ForgeHooksClient
                    .renderInventoryItem(RENDER_BLOCKS, minecraft.getTextureManager(), stack, true, 0.0F, itemX, itemY)
            ) {
                RENDER_ITEM.renderItemIntoGUI(
                    fontRenderer,
                    minecraft.getTextureManager(),
                    stack,
                    itemX,
                    itemY
                );
            }
            RenderHelper.disableStandardItemLighting();
            GL11.glDisable(GL12.GL_RESCALE_NORMAL);
            resetTessellator();
        } finally {
            RenderHelper.disableStandardItemLighting();
            GL11.glDisable(GL12.GL_RESCALE_NORMAL);
            resetTessellator();
            if (modelViewPushed) {
                GL11.glMatrixMode(GL11.GL_MODELVIEW);
                GL11.glPopMatrix();
            }
            if (projectionPushed) {
                GL11.glMatrixMode(GL11.GL_PROJECTION);
                GL11.glPopMatrix();
            }
            GL11.glMatrixMode(GL11.GL_MODELVIEW);
            restoreGlState(modelViewDepth, projectionDepth);
            framebuffer.unbindFramebuffer();
        }
    }

    /**
     * An icon's GL output, read on the render thread: the stack's pixels, its tint, and for a cell or capsule the
     * bases it is drawn over. The capsule base is used when it renders visibly, the empty cell otherwise; a base
     * that fails to render leaves the overlay alone.
     */
    private static final class RenderedPixels {
        ByteBuffer overlay;
        int tint;
        boolean wantsBase;
        boolean isCapsule;
        ByteBuffer capsuleBase;
        boolean capsuleFailed;
        ByteBuffer emptyCellBase;
        boolean emptyCellFailed;
    }

    /** An icon drawn into the batch, waiting for the batch's read-back before it goes to an encode thread. */
    private static final class PendingIcon {
        final String key;
        final ItemStack stack;
        final File outFile;
        final File cachedFile;
        final RenderedPixels pixels = new RenderedPixels();
        int overlayCell = -1;
        int capsuleCell = -1;
        int emptyCellCell = -1;

        PendingIcon(String key, ItemStack stack, File outFile, File cachedFile) {
            this.key = key;
            this.stack = stack;
            this.outFile = outFile;
            this.cachedFile = cachedFile;
        }
    }

    /** The batch and the icons drawn into it, flushed to the encoder whenever it fills and at the end of each frame. */
    private static final class GridBatch {
        private final IconGrid grid = new IconGrid();
        private final List<PendingIcon> pending = new ArrayList<PendingIcon>();
        private final IconCache cache;

        GridBatch(IconCache cache) {
            this.cache = cache;
        }

        void add(final String key, ItemStack stack, File outFile, File cachedFile, ThreadPoolExecutor encoder,
            IconTally tally) throws Exception {
            boolean wantsBase = shouldRenderContainerBase(stack);
            boolean isCapsule = wantsBase && isCapsuleStack(stack);
            int needed = 1 + (wantsBase ? (isCapsule ? 2 : 1) : 0);
            if (grid.free() < needed) {
                flush(encoder, tally);
            }

            PendingIcon icon = new PendingIcon(key, stack, outFile, cachedFile);
            icon.overlayCell = grid.draw(stack);
            RenderedPixels pixels = icon.pixels;
            pixels.tint = stackTintColor(stack);
            pixels.wantsBase = wantsBase;
            pixels.isCapsule = isCapsule;
            if (wantsBase) {
                if (isCapsule) {
                    try {
                        icon.capsuleCell = grid.draw(new ItemStack(stack.getItem(), 1, 0));
                    } catch (Throwable ignored) {
                        pixels.capsuleFailed = true;
                    }
                }
                Item emptyCellItem = (Item) Item.itemRegistry.getObject("IC2:itemCellEmpty");
                if (!pixels.capsuleFailed && emptyCellItem != null) {
                    try {
                        icon.emptyCellCell = grid.draw(new ItemStack(emptyCellItem, 1, 0));
                    } catch (Throwable ignored) {
                        pixels.emptyCellFailed = true;
                    }
                }
            }
            pending.add(icon);
        }

        void flush(ThreadPoolExecutor encoder, final IconTally tally) {
            if (pending.isEmpty() && grid.free() == READ_BACK_BATCH) {
                return;
            }
            byte[][] cells;
            try {
                cells = grid.readBack();
            } catch (Throwable t) {
                for (PendingIcon icon : pending) {
                    tally.count(MaterializedIconResult.SKIPPED);
                    markSkipped(icon.key);
                    warnRenderFailure(icon.stack, t);
                }
                pending.clear();
                return;
            }
            for (final PendingIcon icon : pending) {
                icon.pixels.overlay = ByteBuffer.wrap(cells[icon.overlayCell]);
                if (icon.capsuleCell >= 0) {
                    icon.pixels.capsuleBase = ByteBuffer.wrap(cells[icon.capsuleCell]);
                }
                if (icon.emptyCellCell >= 0) {
                    icon.pixels.emptyCellBase = ByteBuffer.wrap(cells[icon.emptyCellCell]);
                }
                encoder.execute(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            tally.count(finishIcon(icon.key, icon.pixels, icon.outFile, icon.cachedFile, cache));
                        } catch (Throwable t) {
                            tally.count(MaterializedIconResult.SKIPPED);
                            markSkipped(icon.key);
                            warnRenderFailure(icon.stack, t);
                        }
                    }
                });
            }
            pending.clear();
        }
    }

    private static BufferedImage withContainerBase(RenderedPixels pixels, BufferedImage overlay) {
        if (!pixels.wantsBase || pixels.capsuleFailed) {
            return overlay;
        }

        try {
            BufferedImage base = null;
            if (pixels.isCapsule) {
                BufferedImage capsuleImage = imageFromRgbaBuffer(pixels.capsuleBase);
                if (imageHasVisiblePixels(capsuleImage) && missingTextureRatio(capsuleImage) <= 0.5D) {
                    base = capsuleImage;
                }
            }
            if (base == null) {
                if (pixels.emptyCellFailed || pixels.emptyCellBase == null) {
                    return overlay;
                }
                base = imageFromRgbaBuffer(pixels.emptyCellBase);
            }

            BufferedImage combined = new BufferedImage(overlay.getWidth(), overlay.getHeight(), BufferedImage.TYPE_INT_ARGB);
            Graphics2D graphics = combined.createGraphics();
            try {
                graphics.drawImage(base, 0, 0, null);
                graphics.drawImage(overlay, 0, 0, null);
            } finally {
                graphics.dispose();
            }
            return combined;
        } catch (Throwable ignored) {
            return overlay;
        }
    }

    private static boolean shouldRenderContainerBase(ItemStack stack) {
        String displayName;
        try {
            displayName = String.valueOf(stack.getDisplayName());
        } catch (Throwable ignored) {
            return false;
        }

        if (
            (!displayName.endsWith(" Cell") && !displayName.endsWith(" Capsule"))
                || "Empty Cell".equals(displayName)
                || "Empty Capsule".equals(displayName)
        ) {
            return false;
        }

        String registryName = String.valueOf(Item.itemRegistry.getNameForObject(stack.getItem()));
        return registryName.startsWith("gregtech:")
            || registryName.startsWith("IC2:")
            || registryName.startsWith("miscutils:")
            || registryName.startsWith("bartworks:");
    }

    private static boolean isCapsuleStack(ItemStack stack) {
        try {
            return String.valueOf(stack.getDisplayName()).endsWith(" Capsule");
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static final class IconExportScreen extends GuiScreen {

        private final Runnable afterExport;
        private boolean done;

        private IconExportScreen(Runnable afterExport) {
            this.afterExport = afterExport;
        }

        @Override
        public void drawScreen(int mouseX, int mouseY, float partialTicks) {
            if (done) {
                return;
            }
            done = true;
            writeIconMap();
            GtnhCalcOracleMod.LOG.info("GTNH 1.7.10 icon exporter finished initialisation.");
            mc.displayGuiScreen(null);
            afterExport.run();
        }
    }

    private static final class QueuedIconExportScreen extends GuiScreen {

        private final Runnable afterExport;
        private final Iterator<Map.Entry<String, ItemStack>> iterator;
        private final int total;
        private final IconPass pass;
        private int processed;
        private boolean finished;

        private QueuedIconExportScreen(Runnable afterExport) {
            this.afterExport = afterExport;
            this.iterator = PENDING_STACKS_BY_KEY.entrySet().iterator();
            this.total = PENDING_STACKS_BY_KEY.size();
            this.pass = new IconPass();
            GtnhCalcOracleMod.LOG.info(
                "GTNH 1.7.10 item icon batch started: "
                    + total
                    + " queued, size "
                    + ICON_SIZE
                    + "px, batch "
                    + ICON_EXPORT_BATCH_SIZE
                    + ", "
                    + ICON_ENCODE_THREADS
                    + " encode thread(s)."
            );
        }

        @Override
        public void drawScreen(int mouseX, int mouseY, float partialTicks) {
            if (finished) {
                return;
            }
            // Item and fluid icons both render with every animation on its first frame.
            IconAnimationFreezer.freeze();

            // Icons whose cache file failed its check on an encode thread render now.
            int batch = 0;
            for (PendingRender retry; (retry = pass.retries.poll()) != null;) {
                batch++;
                try {
                    pass.batch.add(retry.key, retry.stack, retry.outFile, retry.cachedFile, pass.encoder, pass.tally);
                } catch (Throwable t) {
                    pass.tally.count(MaterializedIconResult.SKIPPED);
                    markSkipped(retry.key);
                    warnRenderFailure(retry.stack, t);
                }
            }

            // A frame draws up to a batch of icons; cache hits draw nothing and go to the encode threads, so a frame
            // hands over many more of them. Frames are capped at 30 a second on a menu screen.
            int seen = 0;
            while (batch < ICON_EXPORT_BATCH_SIZE && seen < ICON_EXPORT_BATCH_SIZE * HITS_PER_DRAW && iterator.hasNext()) {
                final Map.Entry<String, ItemStack> entry = iterator.next();
                processed++;
                seen++;
                try {
                    MaterializedIconResult result = materializeIcon(entry.getKey(), entry.getValue(), pass);
                    if (result == MaterializedIconResult.QUEUED) {
                        batch++;
                    } else if (result != MaterializedIconResult.HIT_QUEUED) {
                        batch++;
                        pass.tally.count(result);
                    }
                } catch (Throwable t) {
                    pass.tally.count(MaterializedIconResult.SKIPPED);
                    markSkipped(entry.getKey());
                    warnRenderFailure(entry.getValue(), t);
                }

                if (processed % ICON_PROGRESS_EVERY == 0 || processed == total) {
                    GtnhCalcOracleMod.LOG.info(
                        "GTNH item icon progress "
                            + processed
                            + "/"
                            + total
                            + " (rendered "
                            + pass.tally.rendered.get()
                            + ", cache "
                            + pass.tally.cacheHits.get()
                            + ", skipped "
                            + pass.tally.skipped.get()
                            + ")."
                    );
                }
            }

            // Every frame ends with its icons read back, so nothing waits in the grid across a frame.
            pass.flush();

            // The pass ends once every cache hit is written; a hit that fell back to rendering is drawn first.
            if (!iterator.hasNext() && pass.outstandingHits.get() == 0 && pass.retries.isEmpty()) {
                finished = true;
                // The icon map names only icons that were written, so it waits for the encoder to drain.
                pass.encoder.shutdown();
                try {
                    if (!pass.encoder.awaitTermination(1, TimeUnit.HOURS)) {
                        GtnhCalcOracleMod.LOG.warn("GTNH item icon encoder did not finish within an hour.");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                writeIconMap();
                GtnhCalcOracleMod.LOG.info(
                    "GTNH item icon batch finished: rendered "
                        + pass.tally.rendered.get()
                        + ", cache "
                        + pass.tally.cacheHits.get()
                        + ", skipped "
                        + pass.tally.skipped.get()
                        + "."
                );
                ClientFluidStackIconRenderer.exportQueuedIconsThen(pass.cache, new Runnable() {
                    @Override
                    public void run() {
                        IconAnimationFreezer.thaw();
                        pass.cache.close();
                        try {
                            IconColors.write(iconDir());
                        } catch (IOException e) {
                            GtnhCalcOracleMod.LOG.warn("Could not write GTNH icon colours.", e);
                        }
                        mc.displayGuiScreen(null);
                        afterExport.run();
                    }
                });
            }
        }
    }

    /** Counts icons as they finish, on the render thread or an encode thread. */
    private static final class IconTally {
        final AtomicInteger rendered = new AtomicInteger();
        final AtomicInteger cacheHits = new AtomicInteger();
        final AtomicInteger skipped = new AtomicInteger();

        void count(MaterializedIconResult result) {
            if (result == MaterializedIconResult.RENDERED) {
                rendered.incrementAndGet();
            } else if (result == MaterializedIconResult.CACHE_HIT) {
                cacheHits.incrementAndGet();
            } else {
                skipped.incrementAndGet();
            }
        }
    }

    /**
     * A bounded pool: when its queue is full the render thread encodes the icon itself, which keeps the pixels
     * waiting in memory to a few hundred icons. The queue holds two read-back batches, so a batch handed over at
     * once does not land back on the render thread.
     */
    private static ThreadPoolExecutor newEncoder() {
        final AtomicInteger threads = new AtomicInteger();
        return new ThreadPoolExecutor(
            ICON_ENCODE_THREADS,
            ICON_ENCODE_THREADS,
            0L,
            TimeUnit.MILLISECONDS,
            new ArrayBlockingQueue<Runnable>(Math.max(ICON_ENCODE_THREADS * 4, READ_BACK_BATCH * 2)),
            new ThreadFactory() {
                @Override
                public Thread newThread(Runnable runnable) {
                    Thread thread = new Thread(runnable, "gtnh-oracle-icon-encode-" + threads.incrementAndGet());
                    thread.setDaemon(true);
                    return thread;
                }
            },
            new ThreadPoolExecutor.CallerRunsPolicy()
        );
    }

    private enum MaterializedIconResult {
        RENDERED,
        CACHE_HIT,
        SKIPPED,
        /** Drawn into the grid; counted when its encode finishes. */
        QUEUED,
        /** Handed to an encode thread as a cache hit; counted there, or rendered after all. */
        HIT_QUEUED
    }

    /** Cache hits handed over per icon a frame may draw: a hit costs the render thread a lookup and a hand-off. */
    private static final int HITS_PER_DRAW = Integer.getInteger("gtnh.oracle.iconHitsPerDraw", 16);

    /** An icon whose cache file failed its check off the render thread, waiting to be drawn after all. */
    private static final class PendingRender {
        final String key;
        final ItemStack stack;
        final File outFile;
        final File cachedFile;

        PendingRender(String key, ItemStack stack, File outFile, File cachedFile) {
            this.key = key;
            this.stack = stack;
            this.outFile = outFile;
            this.cachedFile = cachedFile;
        }
    }

    /**
     * What one icon pass shares: the encoder, the counts, the grid, and the names already in the icon and cache
     * directories, listed once. Asking the file system per icon cost an eighth of the render thread on a mounted
     * directory.
     */
    private static final class IconPass {
        final ThreadPoolExecutor encoder = newEncoder();
        final IconTally tally = new IconTally();
        final IconCache cache = IconCache.open(cacheDir());
        final GridBatch batch = new GridBatch(cache);
        final File outDir = iconDir();
        final boolean outDirReady = outDir.exists() || outDir.mkdirs();
        final Set<String> iconNames = listNames(outDir);
        final AtomicInteger outstandingHits = new AtomicInteger();
        final ConcurrentLinkedQueue<PendingRender> retries = new ConcurrentLinkedQueue<PendingRender>();

        void flush() {
            batch.flush(encoder, tally);
        }
    }

    private static Set<String> listNames(File dir) {
        Set<String> names = new HashSet<String>();
        String[] listed = dir.list();
        if (listed != null) {
            Collections.addAll(names, listed);
        }
        return names;
    }

    private static MaterializedIconResult materializeIcon(final String key, final ItemStack stack, IconPass pass)
        throws Exception {
        String filename;
        synchronized (ICONS_BY_STACK_KEY) {
            filename = ICONS_BY_STACK_KEY.get(key);
        }
        if (filename == null || filename.length() == 0) {
            return MaterializedIconResult.SKIPPED;
        }

        if (!pass.outDirReady) {
            return MaterializedIconResult.SKIPPED;
        }

        final File outFile = new File(pass.outDir, filename);
        if (pass.iconNames.contains(filename)) {
            return MaterializedIconResult.SKIPPED;
        }

        long start = System.nanoTime();
        final File cachedFile = cacheFileForKey(key, filename);
        final File legacyCachedFile = cacheFile(filename);
        pass.cache.timings.cacheKey.addAndGet(IconCache.Timings.since(start));

        // The name counts as taken once queued, so a second stack with the same file name is skipped as before.
        pass.iconNames.add(filename);
        if (pass.cache.has(cachedFile.getName()) || pass.cache.has(legacyCachedFile.getName())) {
            queueCacheHit(key, stack, filename, outFile, cachedFile, legacyCachedFile, pass);
            pass.cache.timings.renderThread.addAndGet(IconCache.Timings.since(start));
            return MaterializedIconResult.HIT_QUEUED;
        }

        pass.batch.add(key, stack, outFile, cachedFile, pass.encoder, pass.tally);
        return MaterializedIconResult.QUEUED;
    }

    /**
     * A cache hit on an encode thread: the cache writes the icon and its colour. One that fails its check goes back
     * to the render thread to be drawn. When the pool is full the render thread runs it itself.
     */
    private static void queueCacheHit(final String key, final ItemStack stack, final String filename,
        final File outFile, final File cachedFile, final File legacyCachedFile, final IconPass pass) {
        pass.outstandingHits.incrementAndGet();
        try {
            executeCacheHit(key, stack, filename, outFile, cachedFile, legacyCachedFile, pass);
        } catch (Throwable t) {
            // A hit the pool did not take renders instead, so the pass still ends.
            pass.retries.add(new PendingRender(key, stack, outFile, cachedFile));
            pass.outstandingHits.decrementAndGet();
        }
    }

    private static void executeCacheHit(final String key, final ItemStack stack, final String filename,
        final File outFile, final File cachedFile, final File legacyCachedFile, final IconPass pass) {
        pass.encoder.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    if (pass.cache.materialize(filename, cachedFile, legacyCachedFile, outFile, true)) {
                        pass.tally.count(MaterializedIconResult.CACHE_HIT);
                    } else {
                        pass.retries.add(new PendingRender(key, stack, outFile, cachedFile));
                    }
                } catch (Throwable t) {
                    pass.retries.add(new PendingRender(key, stack, outFile, cachedFile));
                } finally {
                    pass.outstandingHits.decrementAndGet();
                }
            }
        });
    }

    /** The CPU half of an icon, safe off the render thread: tint, base, checks, one PNG encode, two writes. */
    private static MaterializedIconResult finishIcon(String key, RenderedPixels pixels, File outFile, File cachedFile,
        IconCache cache) throws IOException {
        BufferedImage image = imageFromRgbaBuffer(pixels.overlay);
        applyTint(pixels.tint, image);
        image = withContainerBase(pixels, image);
        int[] argb = argbOf(image);
        if (!IconChecks.usable(argb)) {
            markSkipped(key);
            warnRejectedIcon(key, argb);
            return MaterializedIconResult.SKIPPED;
        }

        BufferedImage pixelArt = asPixelArt(image);
        BufferedImage stored = pixelArt != null ? pixelArt : image;
        // The colour of the pixels written, as a cache hit and the normalizer read them back.
        String colour = IconColors.dominantOpaqueColor(stored);
        IconColors.recordColour(outFile.getName(), colour);
        byte[] png = encodePng(stored);
        Files.write(outFile.toPath(), png);
        cache.store(cachedFile, png, colour);
        // A key dropped by an earlier draw and written now (a retry) is no longer a drop.
        synchronized (DROPPED_ICONS) {
            DROPPED_ICONS.remove(key);
        }
        return MaterializedIconResult.RENDERED;
    }

    /**
     * A flat item drawn from 16x16 textures fills whole squares of ICON_SIZE / PIXEL_ART_SIZE pixels: its 16
     * texels across the middle and 8 texels of margin around them, room for glows that overflow the slot. Such an
     * icon is stored at one pixel per square, which loses nothing, since the planner scales it back up nearest
     * neighbour. Blocks and models are rasterized geometry with sloped edges and keep the full size.
     */
    static final int PIXEL_ART_SIZE = 32;

    /** The icon at one pixel per square, or null when any square holds more than one colour. */
    static BufferedImage asPixelArt(BufferedImage image) {
        int size = image.getWidth();
        if (image.getHeight() != size || size % PIXEL_ART_SIZE != 0) {
            return null;
        }
        int cell = size / PIXEL_ART_SIZE;
        int[] argb = argbOf(image);
        for (int y = 0; y < size; y++) {
            int squareRow = (y - y % cell) * size;
            for (int x = 0; x < size; x++) {
                if (argb[y * size + x] != argb[squareRow + x - x % cell]) {
                    return null;
                }
            }
        }
        BufferedImage small = new BufferedImage(PIXEL_ART_SIZE, PIXEL_ART_SIZE, BufferedImage.TYPE_INT_ARGB);
        int[] out = argbOf(small);
        for (int y = 0; y < PIXEL_ART_SIZE; y++) {
            for (int x = 0; x < PIXEL_ART_SIZE; x++) {
                out[y * PIXEL_ART_SIZE + x] = argb[y * cell * size + x * cell];
            }
        }
        return small;
    }

    /**
     * The same PNG writer ImageIO.write(image, "png", file) uses, into memory: an OutputStream target would
     * otherwise buffer through a temporary file.
     */
    static byte[] encodePng(BufferedImage image) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(64 * 1024);
        MemoryCacheImageOutputStream stream = new MemoryCacheImageOutputStream(bytes);
        try {
            if (!ImageIO.write(image, "png", stream)) {
                throw new IOException("No PNG writer is registered.");
            }
        } finally {
            stream.close();
        }
        return bytes.toByteArray();
    }

    private static void markSkipped(String key) {
        synchronized (ICONS_BY_STACK_KEY) {
            ICONS_BY_STACK_KEY.put(key, "");
        }
    }

    static BufferedImage imageFromRgbaBuffer(ByteBuffer buffer) {
        BufferedImage image = new BufferedImage(ICON_SIZE, ICON_SIZE, BufferedImage.TYPE_INT_ARGB);
        int[] argb = argbOf(image);
        for (int y = 0; y < ICON_SIZE; y++) {
            for (int x = 0; x < ICON_SIZE; x++) {
                int index = (x + (ICON_SIZE - 1 - y) * ICON_SIZE) * 4;
                int red = buffer.get(index) & 255;
                int green = buffer.get(index + 1) & 255;
                int blue = buffer.get(index + 2) & 255;
                int alpha = buffer.get(index + 3) & 255;
                argb[x + y * ICON_SIZE] = (alpha << 24) | (red << 16) | (green << 8) | blue;
            }
        }
        return image;
    }

    /**
     * The image's pixels as ARGB ints, row by row from the top. A TYPE_INT_ARGB image hands over its own array, so
     * writes land in the image; any other type gets a copy. Per-pixel getRGB and setRGB went through the colour model
     * for every pixel and made up most of an icon's CPU time.
     */
    static int[] argbOf(BufferedImage image) {
        if (image.getType() == BufferedImage.TYPE_INT_ARGB) {
            return ((DataBufferInt) image.getRaster().getDataBuffer()).getData();
        }
        return image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());
    }

    static boolean imageHasVisiblePixels(BufferedImage image) {
        return IconChecks.hasVisiblePixels(argbOf(image));
    }

    static double missingTextureRatio(BufferedImage image) {
        return IconChecks.missingTextureRatio(argbOf(image));
    }

    private static void applyTint(int color, BufferedImage image) {
        if (color < 0) {
            return;
        }

        if ((color & 0x00FFFFFF) == 0x00FFFFFF || !imageLooksUntinted(image)) {
            return;
        }

        int tintRed = (color >> 16) & 255;
        int tintGreen = (color >> 8) & 255;
        int tintBlue = color & 255;

        int[] argb = argbOf(image);
        for (int i = 0; i < argb.length; i++) {
            int value = argb[i];
            int alpha = (value >>> 24) & 255;
            if (alpha == 0) {
                continue;
            }

            int red = (((value >> 16) & 255) * tintRed) / 255;
            int green = (((value >> 8) & 255) * tintGreen) / 255;
            int blue = ((value & 255) * tintBlue) / 255;
            argb[i] = (alpha << 24) | (red << 16) | (green << 8) | blue;
        }
        if (image.getType() != BufferedImage.TYPE_INT_ARGB) {
            image.setRGB(0, 0, image.getWidth(), image.getHeight(), argb, 0, image.getWidth());
        }
    }

    private static boolean imageLooksUntinted(BufferedImage image) {
        int visiblePixels = 0;
        int neutralPixels = 0;
        for (int value : argbOf(image)) {
            int alpha = (value >>> 24) & 255;
            if (alpha == 0) {
                continue;
            }

            visiblePixels++;
            int red = (value >> 16) & 255;
            int green = (value >> 8) & 255;
            int blue = value & 255;
            int max = Math.max(red, Math.max(green, blue));
            int min = Math.min(red, Math.min(green, blue));
            if (max - min <= 10) {
                neutralPixels++;
            }
        }

        return visiblePixels > 0 && (double) neutralPixels / (double) visiblePixels > 0.85D;
    }

    private static int stackTintColor(ItemStack stack) {
        int gregTechColor = gregTechMaterialColor(stack);
        if (gregTechColor >= 0) {
            return gregTechColor;
        }

        try {
            return stack.getItem().getColorFromItemStack(stack, 0) & 0x00FFFFFF;
        } catch (Throwable ignored) {
            return -1;
        }
    }

    private static int gregTechMaterialColor(ItemStack stack) {
        Object item = stack.getItem();
        Class<?> type = item.getClass();
        while (type != null) {
            int methodColor = gregTechMaterialColorFromMethod(item, type, stack);
            if (methodColor >= 0) {
                return methodColor;
            }

            int fieldColor = gregTechMaterialColorFromField(item, type, stack.getItemDamage());
            if (fieldColor >= 0) {
                return fieldColor;
            }
            type = type.getSuperclass();
        }

        return -1;
    }

    private static int gregTechMaterialColorFromMethod(Object item, Class<?> type, ItemStack stack) {
        String[] methodNames = new String[] { "getRGBa", "getRGBA" };
        for (String methodName : methodNames) {
            try {
                Method method = type.getDeclaredMethod(methodName, ItemStack.class);
                method.setAccessible(true);
                int color = colorFromRgbArray(method.invoke(item, stack));
                if (color >= 0) {
                    return color;
                }
            } catch (Throwable ignored) {
            }
        }

        return -1;
    }

    private static int gregTechMaterialColorFromField(Object item, Class<?> type, int meta) {
        try {
            Field field = type.getDeclaredField("mRGBa");
            field.setAccessible(true);
            Object table = field.get(item);
            if (table == null || !table.getClass().isArray() || meta < 0 || meta >= Array.getLength(table)) {
                return -1;
            }

            return colorFromRgbArray(Array.get(table, meta));
        } catch (Throwable ignored) {
            return -1;
        }
    }

    private static int colorFromRgbArray(Object value) {
        if (value == null || !value.getClass().isArray() || Array.getLength(value) < 3) {
            return -1;
        }

        int red = colorChannel(Array.get(value, 0));
        int green = colorChannel(Array.get(value, 1));
        int blue = colorChannel(Array.get(value, 2));
        if (red < 0 || green < 0 || blue < 0) {
            return -1;
        }

        return (red << 16) | (green << 8) | blue;
    }

    private static int colorChannel(Object value) {
        if (!(value instanceof Number)) {
            return -1;
        }
        int channel = ((Number) value).intValue();
        return Math.max(0, Math.min(255, channel));
    }

    static File iconDir() {
        String configured = System.getProperty("gtnh.oracle.iconDir");
        if (configured != null && configured.trim().length() > 0) {
            return new File(configured);
        }
        return new File(Minecraft.getMinecraft().mcDataDir, "GTNH-Calc-Oracle-Rendered-Icons");
    }

    static File cacheDir() {
        String configured = System.getProperty("gtnh.oracle.iconCacheDir");
        if (configured != null && configured.trim().length() > 0) {
            return new File(configured);
        }
        return new File(iconDir(), ".cache-" + ICON_SIZE);
    }

    static File cacheFile(String filename) {
        return new File(cacheDir(), filename);
    }

    static File cacheFileForKey(String key, String defaultFilename) {
        try {
            return new File(cacheDir(), "stack-" + sha1(key) + ".png");
        } catch (Throwable t) {
            return cacheFile(defaultFilename);
        }
    }

    /** GL switches item rendering touches, as they stood before the first icon. */
    private static final int[] SAVED_CAPS = new int[] { GL11.GL_BLEND, GL11.GL_ALPHA_TEST, GL11.GL_DEPTH_TEST,
        GL11.GL_CULL_FACE, GL11.GL_LIGHTING, GL11.GL_COLOR_MATERIAL, GL11.GL_FOG, GL11.GL_TEXTURE_2D,
        GL12.GL_RESCALE_NORMAL, GL11.GL_NORMALIZE, GL11.GL_LIGHT0, GL11.GL_LIGHT1 };
    private static boolean[] savedCaps;
    private static boolean savedLightmapTexture;
    private static int savedBlendSrc, savedBlendDst, savedAlphaFunc, savedDepthFunc, savedShadeModel;
    private static int savedFrontFace, savedCullFaceMode;
    private static float savedAlphaRef;
    private static boolean savedDepthMask;

    /** Remembers the GL state the first icon renders in; every later render is put back to it. */
    static void saveGlStateOnce() {
        if (savedCaps != null) {
            return;
        }
        boolean[] caps = new boolean[SAVED_CAPS.length];
        for (int i = 0; i < SAVED_CAPS.length; i++) {
            caps[i] = GL11.glIsEnabled(SAVED_CAPS[i]);
        }
        OpenGlHelper.setActiveTexture(OpenGlHelper.lightmapTexUnit);
        savedLightmapTexture = GL11.glIsEnabled(GL11.GL_TEXTURE_2D);
        OpenGlHelper.setActiveTexture(OpenGlHelper.defaultTexUnit);
        savedBlendSrc = GL11.glGetInteger(GL11.GL_BLEND_SRC);
        savedBlendDst = GL11.glGetInteger(GL11.GL_BLEND_DST);
        savedAlphaFunc = GL11.glGetInteger(GL11.GL_ALPHA_TEST_FUNC);
        savedAlphaRef = GL11.glGetFloat(GL11.GL_ALPHA_TEST_REF);
        savedDepthFunc = GL11.glGetInteger(GL11.GL_DEPTH_FUNC);
        savedDepthMask = GL11.glGetBoolean(GL11.GL_DEPTH_WRITEMASK);
        savedShadeModel = GL11.glGetInteger(GL11.GL_SHADE_MODEL);
        savedFrontFace = GL11.glGetInteger(GL11.GL_FRONT_FACE);
        savedCullFaceMode = GL11.glGetInteger(GL11.GL_CULL_FACE_MODE);
        savedCaps = caps;
    }

    /** Back to the state the first icon rendered in: shader, matrix stacks, texture units, switches, colour. */
    static void restoreGlState(final int modelViewDepth, final int projectionDepth) {
        try {
            GL20.glUseProgram(0);
        } catch (Throwable ignored) {
        }
        GL11.glMatrixMode(GL11.GL_PROJECTION);
        for (int i = 0; i < 32 && GL11.glGetInteger(GL11.GL_PROJECTION_STACK_DEPTH) > Math.max(1, projectionDepth); i++) {
            GL11.glPopMatrix();
        }
        GL11.glMatrixMode(GL11.GL_MODELVIEW);
        for (int i = 0; i < 32 && GL11.glGetInteger(GL11.GL_MODELVIEW_STACK_DEPTH) > Math.max(1, modelViewDepth); i++) {
            GL11.glPopMatrix();
        }
        resetTessellator();
        applySavedGlState();
    }

    /**
     * The switches, functions and colour the first icon rendered in. Applied before every icon as well as after it:
     * the first icon of each frame otherwise drew in whatever state the menu screen left, and a fresh 2.9 export
     * drew about a hundred blocks there inside out (back faces over front ones: ores, slabs, machines).
     */
    static void applySavedGlState() {
        if (savedCaps == null) {
            return;
        }
        OpenGlHelper.setActiveTexture(OpenGlHelper.lightmapTexUnit);
        setCap(GL11.GL_TEXTURE_2D, savedLightmapTexture);
        OpenGlHelper.setActiveTexture(OpenGlHelper.defaultTexUnit);
        for (int i = 0; i < SAVED_CAPS.length; i++) {
            setCap(SAVED_CAPS[i], savedCaps[i]);
        }
        GL11.glTexEnvi(GL11.GL_TEXTURE_ENV, GL11.GL_TEXTURE_ENV_MODE, GL11.GL_MODULATE);
        GL11.glBlendFunc(savedBlendSrc, savedBlendDst);
        GL11.glAlphaFunc(savedAlphaFunc, savedAlphaRef);
        GL11.glDepthFunc(savedDepthFunc);
        GL11.glDepthMask(savedDepthMask);
        GL11.glShadeModel(savedShadeModel);
        // Face winding, the culled side and the item unit's texture matrix go back too, like the switches above.
        GL11.glFrontFace(savedFrontFace);
        GL11.glCullFace(savedCullFaceMode);
        GL11.glMatrixMode(GL11.GL_TEXTURE);
        GL11.glLoadIdentity();
        GL11.glMatrixMode(GL11.GL_MODELVIEW);
        GL11.glColorMask(true, true, true, true);
        GL11.glPolygonMode(GL11.GL_FRONT_AND_BACK, GL11.GL_FILL);
        GL11.glColor4f(1.0F, 1.0F, 1.0F, 1.0F);
        Minecraft.getMinecraft().getTextureManager().bindTexture(TextureMap.locationItemsTexture);
    }

    private static void setCap(final int cap, final boolean enabled) {
        if (enabled) {
            GL11.glEnable(cap);
        } else {
            GL11.glDisable(cap);
        }
    }

    /** Each icon starts from CodeChickenLib's reset, dynamic-lit state (LibraryRenderState says why). */
    private static final LibraryRenderState LIBRARY_RENDER_STATE =
        new LibraryRenderState(LibraryRenderState.CCL_RENDER_STATE);

    static void resetLibraryRenderState() {
        LIBRARY_RENDER_STATE.apply();
    }

    static void resetTessellator() {
        String[] fieldNames = new String[] { "isDrawing", "field_78415_z" };
        for (String fieldName : fieldNames) {
            try {
                Field isDrawing = Tessellator.class.getDeclaredField(fieldName);
                isDrawing.setAccessible(true);
                if (isDrawing.getBoolean(Tessellator.instance)) {
                    isDrawing.setBoolean(Tessellator.instance, false);
                }
                return;
            } catch (Throwable ignored) {
            }
        }
    }

    private static synchronized void warnRenderFailure(ItemStack stack, Throwable throwable) {
        renderWarnings++;
        if (renderWarnings <= MAX_RENDER_WARNINGS || renderWarnings % 1000 == 0) {
            GtnhCalcOracleMod.LOG.warn(
                "GTNH 1.7.10 icon exporter failed for "
                    + stack
                    + " ("
                    + renderWarnings
                    + " failures): "
                    + throwable.toString()
            );
        }
    }

    private static int rejectWarnings;
    /** Every icon the checks dropped and why, written beside icon-map.json: the log shows only the first few. */
    private static final Map<String, String> DROPPED_ICONS = new LinkedHashMap<String, String>();

    /** A drawn icon the checks dropped says why, as a render that threw does. */
    private static synchronized void warnRejectedIcon(String key, int[] argb) {
        rejectWarnings++;
        String reason = IconChecks.hasVisiblePixels(argb)
            ? "missing texture on " + Math.round(IconChecks.missingTextureRatio(argb) * 100) + "% of it"
            : "no visible pixels";
        synchronized (DROPPED_ICONS) {
            DROPPED_ICONS.put(key, reason);
        }
        if (rejectWarnings <= MAX_RENDER_WARNINGS || rejectWarnings % 1000 == 0) {
            GtnhCalcOracleMod.LOG.warn(
                "GTNH 1.7.10 icon exporter dropped " + key + " (" + rejectWarnings + " dropped): " + reason
            );
        }
    }

    static void writeIconMap() {
        synchronized (ICONS_BY_STACK_KEY) {
            writeIconMapLocked();
        }
    }

    private static void writeIconMapLocked() {
        synchronized (DROPPED_ICONS) {
            writeStringMap(new File(iconDir(), "dropped-icons.json"), DROPPED_ICONS);
        }
        writeStringMap(new File(iconDir(), "icon-map.json"), ICONS_BY_STACK_KEY);
    }

    private static void writeStringMap(File file, Map<String, String> map) {
        FileWriter writer = null;
        try {
            writer = new FileWriter(file);
            writer.write("{\n");
            int index = 0;
            for (Map.Entry<String, String> entry : map.entrySet()) {
                if (index > 0) {
                    writer.write(",\n");
                }
                writer.write("  \"" + jsonEscape(entry.getKey()) + "\": \"" + jsonEscape(entry.getValue()) + "\"");
                index++;
            }
            writer.write("\n}\n");
        } catch (IOException e) {
            GtnhCalcOracleMod.LOG.warn("Could not write " + file.getName() + ".", e);
        } finally {
            if (writer != null) {
                try {
                    writer.close();
                } catch (IOException ignored) {
                }
            }
        }
    }

    private static String stackKey(ItemStack stack) {
        String nbt = stack.hasTagCompound() ? stack.getTagCompound().toString() : "";
        return String.valueOf(Item.itemRegistry.getNameForObject(stack.getItem()))
            + "@" + stack.getItemDamage()
            + "#" + nbt;
    }

    private static String safeName(ItemStack stack) {
        String raw;
        try {
            raw = String.valueOf(stack.getDisplayName());
        } catch (Throwable t) {
            raw = String.valueOf(Item.itemRegistry.getNameForObject(stack.getItem()));
        }
        String safe = raw.toLowerCase().replaceAll("[^a-z0-9._-]+", "_").replaceAll("^_+|_+$", "");
        return safe.length() > 0 ? safe.substring(0, Math.min(safe.length(), 60)) : "item";
    }

    static String sha1(String value) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-1");
        byte[] bytes = digest.digest(value.getBytes("UTF-8"));
        StringBuilder builder = new StringBuilder();
        for (byte b : bytes) {
            builder.append(String.format("%02x", b & 255));
        }
        return builder.toString();
    }

    private static String jsonEscape(String value) {
        return String.valueOf(value)
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r");
    }
}
