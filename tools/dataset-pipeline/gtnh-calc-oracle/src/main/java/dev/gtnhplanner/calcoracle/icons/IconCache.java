package dev.gtnhplanner.calcoracle.icons;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import javax.imageio.ImageIO;
import javax.imageio.stream.MemoryCacheImageInputStream;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

/**
 * The icon cache of one export: a PNG per icon in the cache directory, which is the cache, and beside it
 * icon-pack.bin, every cached icon's bytes and colour in one file. Opening a cached file through the export
 * container's bind mount costs about 0.7 ms however many threads ask, so 106k hits read file by file took over a
 * minute even in parallel; the same bytes read out of one open pack cost a tenth of that, and the stored colour
 * spares the decode. A pack entry serves only while the icon's own file is still there with the size and
 * modification time it had when packed; anything else reads the file, decodes it once and checks it as before.
 * An entry whose PNG kept its size but not its mtime (a copy that did not keep times) is compared byte for byte
 * with the file before it serves. An export that changed anything writes a new pack of the icons it used plus the
 * old pack's other entries, under a temporary name renamed into place, so two exports sharing a cache never see
 * half a pack; an export that changed nothing leaves the pack alone.
 */
final class IconCache {

    static final String PACK_NAME = "icon-pack.bin";
    /** The layout written by writeIndex and close and read by readIndex; it changes with them. */
    private static final String LAYOUT = "gtnh-icon-pack/2";
    /**
     * The layout plus what a pack hit takes on trust, the item check and the colour, as their answers on fixed
     * images: a pack written under another check or colour arithmetic does not match and is set aside.
     */
    static final String FORMAT = LAYOUT + ";" + fingerprint();
    private static final long MAGIC = 0x67746e68_69636f6eL;
    /**
     * A pass writes its temporary pack within minutes; one older than this belongs to an export that died. The age
     * runs from the last write, and an all-hit pass never writes, so this relies on the export lock: only one export
     * opens a cache dir at a time, and none can delete another's live temp.
     */
    private static final long STALE_TEMP_MILLIS = 30L * 60 * 1000;

    private static final class Entry {
        final long offset;
        final int length;
        final long fileSize;
        final long fileMtime;
        final String colour;
        /** The bytes are in the old pack at offset, not yet in the new one. */
        final boolean inOld;

        Entry(long offset, int length, long fileSize, long fileMtime, String colour, boolean inOld) {
            this.offset = offset;
            this.length = length;
            this.fileSize = fileSize;
            this.fileMtime = fileMtime;
            this.colour = colour;
            this.inOld = inOld;
        }
    }

    /** Totals over the pass, logged when the pack is written: where the time of a cache hit goes. */
    static final class Timings {
        final AtomicLong stat = new AtomicLong();
        final AtomicLong packRead = new AtomicLong();
        final AtomicLong fileRead = new AtomicLong();
        final AtomicLong decode = new AtomicLong();
        final AtomicLong check = new AtomicLong();
        final AtomicLong colour = new AtomicLong();
        final AtomicLong write = new AtomicLong();
        final AtomicLong pack = new AtomicLong();
        final AtomicLong cacheKey = new AtomicLong();
        final AtomicLong renderThread = new AtomicLong();
        final AtomicInteger packHits = new AtomicInteger();
        final AtomicInteger comparedHits = new AtomicInteger();
        final AtomicInteger fileHits = new AtomicInteger();
        final AtomicInteger rejected = new AtomicInteger();
        final AtomicInteger stored = new AtomicInteger();

        static long since(long start) {
            return System.nanoTime() - start;
        }
    }

    private final File dir;
    private final Set<String> names;
    private final Map<String, Entry> oldIndex;
    private final FileChannel oldPack;
    private final Map<String, Entry> newIndex = new ConcurrentHashMap<String, Entry>();
    private FileChannel newPack;
    private Path newPackPath;
    private long newPackSize;
    /** Set once the pass adds or changes an entry: only then is a new pack written. */
    private volatile boolean changed;
    final Timings timings = new Timings();

    private IconCache(File dir, Set<String> names, Map<String, Entry> oldIndex, FileChannel oldPack) {
        this.dir = dir;
        this.names = names;
        this.oldIndex = oldIndex;
        this.oldPack = oldPack;
    }

    /** Lists the cache directory once (asking per icon cost an eighth of the render thread) and loads its pack. */
    static IconCache open(File dir) {
        if (!dir.exists()) {
            dir.mkdirs();
        }
        Set<String> names = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
        String[] listed = dir.list();
        if (listed != null) {
            Collections.addAll(names, listed);
        }
        deleteStaleTemps(dir, listed);

        Map<String, Entry> index = new HashMap<String, Entry>();
        FileChannel pack = null;
        File packFile = new File(dir, PACK_NAME);
        if (packFile.isFile()) {
            try {
                pack = FileChannel.open(packFile.toPath(), StandardOpenOption.READ);
                index = readIndex(pack);
            } catch (Throwable t) {
                GtnhCalcOracleMod.LOG.warn("GTNH icon pack " + packFile + " is unreadable and was ignored: " + t);
                closeQuietly(pack);
                pack = null;
                index = new HashMap<String, Entry>();
            }
        }

        IconCache cache = new IconCache(dir, names, index, pack);
        try {
            cache.newPackPath = new File(dir, PACK_NAME + "." + UUID.randomUUID() + ".tmp").toPath();
            cache.newPack = FileChannel.open(
                cache.newPackPath,
                StandardOpenOption.CREATE_NEW,
                StandardOpenOption.WRITE
            );
        } catch (Throwable t) {
            GtnhCalcOracleMod.LOG.warn("Could not start a new GTNH icon pack; icons are cached file by file only.", t);
            cache.newPack = null;
        }
        GtnhCalcOracleMod.LOG.info(
            "GTNH icon cache " + dir + ": " + names.size() + " files, pack of " + index.size() + " icons."
        );
        return cache;
    }

    boolean has(String name) {
        return names.contains(name);
    }

    /**
     * Writes a cached icon to outFile and records its colour under iconName: the keyed cache file, else the legacy
     * one, which is copied to the keyed name. A file that does not pass the check is deleted. False when neither
     * gives an icon, and the caller renders it. Safe on any thread.
     *
     * @param strict the item check (visible pixels, under half missing texture); otherwise the file must only decode
     */
    boolean materialize(String iconName, File cachedFile, File legacyFile, File outFile, boolean strict)
        throws IOException {
        String name = cachedFile.getName();
        if (names.contains(name)) {
            long start = System.nanoTime();
            BasicFileAttributes attrs = stat(cachedFile);
            Entry entry = attrs == null ? null : oldIndex.get(name);
            timings.stat.addAndGet(Timings.since(start));
            byte[] fileBytes = null;
            if (entry != null && entry.fileSize == attrs.size()) {
                byte[] png = readPack(entry);
                boolean sameTime = entry.fileMtime == mtime(attrs);
                if (png != null && !sameTime) {
                    fileBytes = readFile(cachedFile);
                    if (fileBytes == null || !Arrays.equals(png, fileBytes)) {
                        png = null;
                    }
                }
                if (png != null) {
                    deliver(iconName, outFile, png, entry.colour);
                    keepOld(name, entry, sameTime ? null : attrs);
                    (sameTime ? timings.packHits : timings.comparedHits).incrementAndGet();
                    return true;
                }
            }
            if (attrs != null && materializeFile(iconName, cachedFile, fileBytes, null, outFile, attrs, strict)) {
                return true;
            }
            cachedFile.delete();
            names.remove(name);
        }
        if (legacyFile != null && names.contains(legacyFile.getName())) {
            BasicFileAttributes attrs = stat(legacyFile);
            if (attrs != null && materializeFile(iconName, legacyFile, null, cachedFile, outFile, attrs, strict)) {
                return true;
            }
            legacyFile.delete();
            names.remove(legacyFile.getName());
        }
        return false;
    }

    /**
     * One read, one decode, one conversion to ARGB: the bytes go out unchanged, the pixels give the check and the
     * colour. A decoded PNG is not an int ARGB image, so each look at it through getRGB copied it whole.
     * Every test of a hit's pixels goes through IconChecks and every colour through IconColors: the pack format
     * fingerprints those two functions only, so a condition written here instead, or a change to which hits
     * pass {@code strict}, would outlive old packs: bump LAYOUT for either.
     */
    private boolean materializeFile(String iconName, File source, byte[] alreadyRead, File copyTo, File outFile,
        BasicFileAttributes attrs, boolean strict) throws IOException {
        byte[] png = alreadyRead != null ? alreadyRead : readFile(source);
        if (png == null) {
            return false;
        }

        long start = System.nanoTime();
        BufferedImage image = decode(png);
        int[] argb = image == null
            ? null
            : image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());
        timings.decode.addAndGet(Timings.since(start));

        start = System.nanoTime();
        boolean usable = argb != null && (!strict || IconChecks.usable(argb));
        timings.check.addAndGet(Timings.since(start));
        if (!usable) {
            timings.rejected.incrementAndGet();
            return false;
        }

        start = System.nanoTime();
        String colour = IconColors.dominantOpaqueColor(argb);
        timings.colour.addAndGet(Timings.since(start));

        deliver(iconName, outFile, png, colour);
        if (copyTo != null) {
            Files.write(copyTo.toPath(), png);
            names.add(copyTo.getName());
            attrs = stat(copyTo);
        }
        if (attrs != null) {
            keep((copyTo != null ? copyTo : source).getName(), png, colour, attrs);
        }
        timings.fileHits.incrementAndGet();
        return true;
    }

    /** A freshly rendered icon: its cache file, then its pack entry. */
    void store(File cachedFile, byte[] png, String colour) throws IOException {
        if (!dir.exists()) {
            dir.mkdirs();
        }
        Files.write(cachedFile.toPath(), png);
        names.add(cachedFile.getName());
        BasicFileAttributes attrs = stat(cachedFile);
        if (attrs != null) {
            keep(cachedFile.getName(), png, colour, attrs);
        }
        timings.stored.incrementAndGet();
    }

    private byte[] readFile(File file) {
        long start = System.nanoTime();
        try {
            return Files.readAllBytes(file.toPath());
        } catch (IOException e) {
            return null;
        } finally {
            timings.fileRead.addAndGet(Timings.since(start));
        }
    }

    private void deliver(String iconName, File outFile, byte[] png, String colour) throws IOException {
        long start = System.nanoTime();
        Files.write(outFile.toPath(), png);
        timings.write.addAndGet(Timings.since(start));
        IconColors.recordColour(iconName, colour);
    }

    /** Appends the icon to the new pack, once per cache file name. */
    private void keep(String name, byte[] png, String colour, BasicFileAttributes attrs) {
        if (newPack == null || newIndex.containsKey(name)) {
            return;
        }
        long start = System.nanoTime();
        synchronized (this) {
            if (newPack != null && !newIndex.containsKey(name)) {
                try {
                    long offset = newPackSize;
                    writeFully(newPack, ByteBuffer.wrap(png), offset);
                    newPackSize += png.length;
                    newIndex.put(name, new Entry(offset, png.length, attrs.size(), mtime(attrs), colour, false));
                    changed = true;
                } catch (Throwable t) {
                    abandonNewPack(t);
                }
            }
        }
        timings.pack.addAndGet(Timings.since(start));
    }

    /** Keeps an old pack entry as it is, or with the file's new mtime; its bytes are copied over only if needed. */
    private void keepOld(String name, Entry entry, BasicFileAttributes newAttrs) {
        if (newAttrs == null) {
            newIndex.putIfAbsent(name, entry);
            return;
        }
        Entry moved = new Entry(entry.offset, entry.length, newAttrs.size(), mtime(newAttrs), entry.colour, true);
        if (newIndex.putIfAbsent(name, moved) == null) {
            changed = true;
        }
    }

    private byte[] readPack(Entry entry) {
        long start = System.nanoTime();
        try {
            ByteBuffer buffer = ByteBuffer.allocate(entry.length);
            while (buffer.hasRemaining()) {
                if (oldPack.read(buffer, entry.offset + buffer.position()) < 0) {
                    return null;
                }
            }
            return buffer.array();
        } catch (Throwable t) {
            return null;
        } finally {
            timings.packRead.addAndGet(Timings.since(start));
        }
    }

    /**
     * Ends the pass: the old pack's entries this pass did not use follow its own, whenever their files are still
     * listed (a cache shared by packs holds icons the other pack uses), then the index; the result replaces
     * icon-pack.bin. Logs the timings.
     */
    synchronized void close() {
        if (newPack != null) {
            try {
                for (Map.Entry<String, Entry> old : oldIndex.entrySet()) {
                    if (newIndex.containsKey(old.getKey())) {
                        continue;
                    }
                    if (names.contains(old.getKey())) {
                        newIndex.put(old.getKey(), old.getValue());
                    } else {
                        changed = true;
                    }
                }
                if (!changed && oldPack != null) {
                    discardNewPack();
                    GtnhCalcOracleMod.LOG.info("GTNH icon pack unchanged: " + newIndex.size() + " icons.");
                    closeQuietly(oldPack);
                    logTimings();
                    return;
                }
                for (Map.Entry<String, Entry> kept : newIndex.entrySet()) {
                    Entry entry = kept.getValue();
                    if (!entry.inOld) {
                        continue;
                    }
                    long offset = newPackSize;
                    long copied = 0;
                    while (copied < entry.length) {
                        long moved = oldPack.transferTo(entry.offset + copied, entry.length - copied,
                            newPack.position(offset + copied));
                        if (moved <= 0) {
                            throw new IOException("Old icon pack ended early.");
                        }
                        copied += moved;
                    }
                    newPackSize += entry.length;
                    kept.setValue(new Entry(offset, entry.length, entry.fileSize, entry.fileMtime, entry.colour, false));
                }
                byte[] index = writeIndex(newIndex);
                writeFully(newPack, ByteBuffer.wrap(index), newPackSize);
                ByteBuffer footer = ByteBuffer.allocate(16);
                footer.putLong(newPackSize).putLong(MAGIC).flip();
                writeFully(newPack, footer, newPackSize + index.length);
                newPack.force(true);
                newPack.close();
                newPack = null;
                Files.move(newPackPath, new File(dir, PACK_NAME).toPath(), StandardCopyOption.REPLACE_EXISTING,
                    StandardCopyOption.ATOMIC_MOVE);
                GtnhCalcOracleMod.LOG.info("GTNH icon pack written: " + newIndex.size() + " icons.");
            } catch (Throwable t) {
                abandonNewPack(t);
            }
        }
        closeQuietly(oldPack);
        logTimings();
    }

    private void abandonNewPack(Throwable t) {
        GtnhCalcOracleMod.LOG.warn("GTNH icon pack not written; the next export reads icons file by file.", t);
        discardNewPack();
    }

    private void discardNewPack() {
        closeQuietly(newPack);
        newPack = null;
        try {
            Files.deleteIfExists(newPackPath);
        } catch (IOException ignored) {
        }
    }

    private void logTimings() {
        Timings t = timings;
        GtnhCalcOracleMod.LOG.info(
            "GTNH icon cache: " + t.packHits.get() + " pack hits, " + t.comparedHits.get()
                + " pack hits compared with their file, " + t.fileHits.get() + " file hits, "
                + t.rejected.get() + " rejected, " + t.stored.get() + " stored. Seconds summed over threads: "
                + "cache key " + seconds(t.cacheKey) + ", stat " + seconds(t.stat) + ", pack read "
                + seconds(t.packRead) + ", file read " + seconds(t.fileRead) + ", decode " + seconds(t.decode)
                + ", check " + seconds(t.check) + ", colour " + seconds(t.colour) + ", write " + seconds(t.write)
                + ", pack append " + seconds(t.pack) + "; render thread on hits " + seconds(t.renderThread) + "."
        );
    }

    private static String seconds(AtomicLong nanos) {
        return String.format("%.1f", nanos.get() / 1e9);
    }

    private static byte[] writeIndex(Map<String, Entry> index) throws IOException {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(index.size() * 96 + 64);
        DataOutputStream out = new DataOutputStream(bytes);
        out.writeUTF(FORMAT);
        List<String> keys = new ArrayList<String>(index.keySet());
        Collections.sort(keys);
        out.writeInt(keys.size());
        for (String key : keys) {
            Entry entry = index.get(key);
            out.writeUTF(key);
            out.writeLong(entry.offset);
            out.writeInt(entry.length);
            out.writeLong(entry.fileSize);
            out.writeLong(entry.fileMtime);
            out.writeUTF(entry.colour);
        }
        out.flush();
        return bytes.toByteArray();
    }

    private static Map<String, Entry> readIndex(FileChannel pack) throws IOException {
        long size = pack.size();
        if (size < 16) {
            throw new IOException("too short");
        }
        ByteBuffer footer = ByteBuffer.allocate(16);
        readFully(pack, footer, size - 16);
        footer.flip();
        long indexOffset = footer.getLong();
        if (footer.getLong() != MAGIC || indexOffset < 0 || indexOffset > size - 16) {
            throw new IOException("no footer");
        }
        ByteBuffer indexBytes = ByteBuffer.allocate((int) (size - 16 - indexOffset));
        readFully(pack, indexBytes, indexOffset);
        DataInputStream in = new DataInputStream(new ByteArrayInputStream(indexBytes.array()));
        String format = in.readUTF();
        if (!FORMAT.equals(format)) {
            throw new IOException("format " + format + ", not " + FORMAT
                + " (another layout, item check or colour arithmetic)");
        }
        int count = in.readInt();
        Map<String, Entry> index = new HashMap<String, Entry>(Math.max(16, count * 2));
        for (int i = 0; i < count; i++) {
            String name = in.readUTF();
            Entry entry = new Entry(in.readLong(), in.readInt(), in.readLong(), in.readLong(), in.readUTF(), true);
            if (entry.offset < 0 || entry.length < 0 || entry.offset + entry.length > indexOffset) {
                throw new IOException("entry " + name + " lies outside the pack");
            }
            index.put(name, entry);
        }
        return index;
    }

    /** Temporary packs left by exports that died: each is as large as the pack. */
    private static void deleteStaleTemps(File dir, String[] listed) {
        if (listed == null) {
            return;
        }
        long now = System.currentTimeMillis();
        for (String name : listed) {
            if (name.startsWith(PACK_NAME + ".") && name.endsWith(".tmp")) {
                File file = new File(dir, name);
                if (now - file.lastModified() > STALE_TEMP_MILLIS) {
                    file.delete();
                }
            }
        }
    }

    /**
     * The item check's and the colour's answers on fixed images, hashed. The images sweep what either function
     * cuts on: alpha, lightness, saturation weight and hue buckets for the colour, channel bounds and the share
     * limit for the check, plus seeded random ones. A changed threshold, weight or rounding changes some answer.
     */
    static String fingerprint() {
        List<int[]> probes = new ArrayList<int[]>();
        probes.add(new int[16]);
        long seed = 0x5DEECE66DL;
        for (int p = 0; p < 6; p++) {
            int[] argb = new int[1024];
            for (int i = 0; i < argb.length; i++) {
                seed = seed * 6364136223846793005L + 1442695040888963407L;
                int value = (int) (seed >>> 32);
                int alpha = p < 3 ? (value >>> 24) & 255 : (p == 3 ? 23 + (i % 3) : 255);
                argb[i] = (alpha << 24) | (value & 0x00FFFFFF);
            }
            probes.add(argb);
        }
        for (int level = 0; level < 256; level++) {
            // Lightness: a grey, and a saturated red of the same lightness, against a mid blue.
            probes.add(new int[] { 0xFF000000 | level * 0x010101 });
            probes.add(new int[] { 0xFF000000 | (Math.min(255, level * 2) << 16) | (Math.max(0, level * 2 - 255) * 0x0101),
                0xFF3355AA });
            // Alpha: one strong pixel of that alpha against a weak opaque one.
            probes.add(new int[] { (level << 24) | 0xE02020, 0xFF708090 });
        }
        for (int count = 1; count <= 60; count++) {
            // Saturation weight: ten saturated red pixels against a growing number of greyish blue ones.
            int[] argb = new int[10 + count];
            for (int i = 0; i < argb.length; i++) {
                argb[i] = i < 10 ? 0xFFE02020 : 0xFF707890;
            }
            probes.add(argb);
        }
        for (int hue = 0; hue < 360; hue++) {
            // Hue buckets: two pixels a few degrees apart either share a bucket and average, or do not.
            probes.add(new int[] { hueColour(hue), hueColour(hue + 5), 0xFF808080 });
        }
        for (int bound = 200; bound <= 255; bound++) {
            int low = 255 - bound;
            probes.add(new int[] { 0xFF000000 | (bound << 16) | (40 << 8) | 220 });
            probes.add(new int[] { 0xFF000000 | (220 << 16) | (low << 8) | 220 });
            probes.add(new int[] { 0xFF000000 | (220 << 16) | (40 << 8) | bound });
        }
        for (int share = 0; share <= 100; share++) {
            int[] argb = new int[200];
            for (int i = 0; i < argb.length; i++) {
                argb[i] = i < share * 2 ? 0xFFDC28DC : (i < 180 ? 0xFF336699 : 0);
            }
            probes.add(argb);
        }

        for (int black = 0; black <= 100; black++) {
            // The checkerboard's black half: a hundred magenta pixels against a growing number of black ones.
            int[] argb = new int[200];
            for (int i = 0; i < argb.length; i++) {
                argb[i] = i < 100 ? 0xFFDC28DC : (i < 100 + black ? 0xFF141414 : 0);
            }
            probes.add(argb);
        }

        StringBuilder answers = new StringBuilder();
        for (int[] argb : probes) {
            answers.append(IconChecks.usable(argb)).append(',')
                .append(IconChecks.hasVisiblePixels(argb)).append(',')
                .append(Double.doubleToLongBits(IconChecks.missingTextureRatio(argb))).append(',')
                .append(IconColors.dominantOpaqueColor(argb)).append(';');
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(answers.toString().getBytes("UTF-8"));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 8; i++) {
                hex.append(String.format("%02x", digest[i] & 255));
            }
            return hex.toString();
        } catch (Exception e) {
            return Integer.toHexString(answers.toString().hashCode());
        }
    }

    /** A fully saturated, mid-light opaque colour of the hue, in degrees. */
    private static int hueColour(int hue) {
        int h = ((hue % 360) + 360) % 360;
        int x = (int) Math.round(255 * (1 - Math.abs((h / 60.0) % 2 - 1)));
        int r, g, b;
        if (h < 60) { r = 255; g = x; b = 0; }
        else if (h < 120) { r = x; g = 255; b = 0; }
        else if (h < 180) { r = 0; g = 255; b = x; }
        else if (h < 240) { r = 0; g = x; b = 255; }
        else if (h < 300) { r = x; g = 0; b = 255; }
        else { r = 255; g = 0; b = x; }
        return 0xFF000000 | (r << 16) | (g << 8) | b;
    }

    static BufferedImage decode(byte[] png) {
        try {
            // From memory: ImageIO.read(InputStream) would buffer through a temporary file.
            return ImageIO.read(new MemoryCacheImageInputStream(new ByteArrayInputStream(png)));
        } catch (Throwable t) {
            return null;
        }
    }

    private static BasicFileAttributes stat(File file) {
        try {
            return Files.readAttributes(file.toPath(), BasicFileAttributes.class);
        } catch (NoSuchFileException e) {
            return null;
        } catch (IOException e) {
            return null;
        }
    }

    private static long mtime(BasicFileAttributes attrs) {
        return attrs.lastModifiedTime().toMillis();
    }

    private static void writeFully(FileChannel channel, ByteBuffer buffer, long position) throws IOException {
        while (buffer.hasRemaining()) {
            position += channel.write(buffer, position);
        }
    }

    private static void readFully(FileChannel channel, ByteBuffer buffer, long position) throws IOException {
        while (buffer.hasRemaining()) {
            int read = channel.read(buffer, position + buffer.position());
            if (read < 0) {
                throw new IOException("unexpected end of pack");
            }
        }
    }

    private static void closeQuietly(FileChannel channel) {
        if (channel == null) {
            return;
        }
        try {
            channel.close();
        } catch (IOException ignored) {
        }
    }
}
