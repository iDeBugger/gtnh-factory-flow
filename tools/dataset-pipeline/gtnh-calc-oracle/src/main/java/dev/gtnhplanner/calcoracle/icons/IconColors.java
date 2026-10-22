package dev.gtnhplanner.calcoracle.icons;

import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The dominant colour of each written icon, worked out while its pixels are still in memory, so the dataset
 * normalizer does not decode every PNG again. The arithmetic is `getDominantOpaqueColor` in the pipeline's
 * icon-utils.mjs step for step (same doubles, same rounding, ties kept in first-seen order): both must give the
 * same hex for the same pixels.
 */
public final class IconColors {

    public static final String FILE_NAME = "icon-colors.json";
    private static final Map<String, String> COLORS_BY_FILE = new ConcurrentHashMap<String, String>();

    private IconColors() {}

    public static void record(String filename, BufferedImage image) {
        COLORS_BY_FILE.put(filename, dominantOpaqueColor(image));
    }

    /** Writes every recorded colour, sorted by file name so two exports of the same icons write the same file. */
    public static void write(File iconDir) throws IOException {
        Map<String, String> sorted = new TreeMap<String, String>(COLORS_BY_FILE);
        FileWriter writer = new FileWriter(new File(iconDir, FILE_NAME));
        try {
            writer.write("{\n");
            int index = 0;
            for (Map.Entry<String, String> entry : sorted.entrySet()) {
                writer.write(index++ > 0 ? ",\n" : "");
                writer.write("  \"" + jsonEscape(entry.getKey()) + "\": \"" + entry.getValue() + "\"");
            }
            writer.write("\n}\n");
        } finally {
            writer.close();
        }
    }

    public static String dominantOpaqueColor(BufferedImage image) {
        Map<Long, double[]> buckets = new LinkedHashMap<Long, double[]>();
        // An icon has few distinct colours: each one's HSL is worked out once. The sums still run pixel by pixel in
        // the same order, so they come out the same.
        Map<Integer, double[]> hslByRgb = new HashMap<Integer, double[]>();
        for (int value : argbOf(image)) {
            int alpha = (value >>> 24) & 255;
            if (alpha < 24) {
                continue;
            }

            int red = (value >> 16) & 255;
            int green = (value >> 8) & 255;
            int blue = value & 255;
            Integer rgb = Integer.valueOf(value & 0x00FFFFFF);
            double[] hsl = hslByRgb.get(rgb);
            if (hsl == null) {
                hsl = rgbToHsl(red, green, blue);
                hslByRgb.put(rgb, hsl);
            }
            double lightness = hsl[2];
            if (lightness < 0.05 || lightness > 0.96) {
                continue;
            }

            long bucket = jsRound(hsl[0] / 12) * 12;
            double weight = (alpha / 255.0) * (0.35 + hsl[1] * 1.65);
            double[] current = buckets.get(bucket);
            if (current == null) {
                current = new double[4];
                buckets.put(bucket, current);
            }
            current[0] += weight;
            current[1] += red * weight;
            current[2] += green * weight;
            current[3] += blue * weight;
        }

        // A stable sort by weight, heaviest first: equal weights keep the order their buckets were first seen.
        List<double[]> ordered = new ArrayList<double[]>(buckets.values());
        Collections.sort(ordered, new Comparator<double[]>() {
            @Override
            public int compare(double[] left, double[] right) {
                return Double.compare(right[0], left[0]);
            }
        });
        double[] dominant = ordered.isEmpty() ? null : ordered.get(0);
        if (dominant == null || dominant[0] <= 0) {
            return "#6b7280";
        }

        return rgbToHex(
            jsRound(dominant[1] / dominant[0]),
            jsRound(dominant[2] / dominant[0]),
            jsRound(dominant[3] / dominant[0])
        );
    }

    /** Pixels row by row from the top, as getRGB(x, y) visits them; a TYPE_INT_ARGB image's own array, unchanged. */
    private static int[] argbOf(BufferedImage image) {
        if (image.getType() == BufferedImage.TYPE_INT_ARGB) {
            return ((DataBufferInt) image.getRaster().getDataBuffer()).getData();
        }
        return image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());
    }

    private static double[] rgbToHsl(int red, int green, int blue) {
        double r = red / 255.0;
        double g = green / 255.0;
        double b = blue / 255.0;
        double max = Math.max(r, Math.max(g, b));
        double min = Math.min(r, Math.min(g, b));
        double lightness = (max + min) / 2;

        if (max == min) {
            return new double[] { 0, 0, lightness };
        }

        double delta = max - min;
        double saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
        double hue;
        if (max == r) {
            hue = (g - b) / delta + (g < b ? 6 : 0);
        } else if (max == g) {
            hue = (b - r) / delta + 2;
        } else {
            hue = (r - g) / delta + 4;
        }

        return new double[] { hue * 60, saturation, lightness };
    }

    /**
     * JavaScript's Math.round: the nearest integer, halves toward positive infinity. Java's Math.round has the same
     * contract; floor(value + 0.5) does not (0.49999999999999994 + 0.5 rounds up to 1.0).
     */
    private static long jsRound(double value) {
        return Math.round(value);
    }

    private static String rgbToHex(long red, long green, long blue) {
        return "#" + hexByte(red) + hexByte(green) + hexByte(blue);
    }

    private static String hexByte(long value) {
        String hex = Long.toHexString(Math.max(0, Math.min(255, value)));
        return hex.length() < 2 ? "0" + hex : hex;
    }

    private static String jsonEscape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
