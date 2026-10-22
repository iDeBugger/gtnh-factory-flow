package dev.gtnhplanner.calcoracle.icons;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;

import dev.gtnhplanner.calcoracle.GtnhCalcOracleMod;

import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.ITextureObject;
import net.minecraft.client.renderer.texture.TextureAtlasSprite;
import net.minecraft.client.renderer.texture.TextureMap;
import net.minecraft.client.renderer.texture.TextureUtil;
import net.minecraft.util.ResourceLocation;

/**
 * Holds every animated texture on its first frame while icons render. An icon showed whichever frame its texture
 * was on when it was drawn, so fluids, cells and machines with moving parts came out differently on every export.
 * Each animated sprite gets its first frame uploaded the way vanilla uploads a frame, and the atlas's list of
 * animated sprites is emptied until {@link #thaw()}: Angelica's updateAnimations walks that list, so nothing moves.
 */
final class IconAnimationFreezer {

    private static final Map<TextureMap, List<Object>> FROZEN = new IdentityHashMap<TextureMap, List<Object>>();

    private IconAnimationFreezer() {}

    /** On the render thread, before the first icon. */
    static void freeze() {
        if (!FROZEN.isEmpty()) {
            return;
        }
        int sprites = 0;
        for (ResourceLocation location : new ResourceLocation[] { TextureMap.locationBlocksTexture,
            TextureMap.locationItemsTexture }) {
            ITextureObject texture = Minecraft.getMinecraft().getTextureManager().getTexture(location);
            if (!(texture instanceof TextureMap)) {
                continue;
            }
            TextureMap map = (TextureMap) texture;
            try {
                @SuppressWarnings("unchecked")
                List<Object> animated = (List<Object>) field(TextureMap.class, "listAnimatedSprites", "field_94258_i")
                    .get(map);
                List<Object> saved = new ArrayList<Object>(animated);
                Minecraft.getMinecraft().getTextureManager().bindTexture(location);
                for (Object sprite : saved) {
                    if (sprite instanceof TextureAtlasSprite && showFirstFrame((TextureAtlasSprite) sprite)) {
                        sprites++;
                    }
                }
                animated.clear();
                FROZEN.put(map, saved);
            } catch (Throwable t) {
                GtnhCalcOracleMod.LOG.warn("Could not hold the animated textures of " + location + " still.", t);
            }
        }
        GtnhCalcOracleMod.LOG.info("GTNH icon export holds " + sprites + " animated texture(s) on their first frame.");
    }

    /** Gives every atlas its animated sprites back; they run on from the first frame. */
    static void thaw() {
        for (Map.Entry<TextureMap, List<Object>> entry : FROZEN.entrySet()) {
            try {
                @SuppressWarnings("unchecked")
                List<Object> animated = (List<Object>) field(TextureMap.class, "listAnimatedSprites", "field_94258_i")
                    .get(entry.getKey());
                animated.addAll(entry.getValue());
            } catch (Throwable t) {
                GtnhCalcOracleMod.LOG.warn("Could not restore animated textures.", t);
            }
        }
        FROZEN.clear();
    }

    private static boolean showFirstFrame(TextureAtlasSprite sprite) {
        try {
            int frames = sprite.getFrameCount();
            if (frames <= 0) {
                return false;
            }
            int first = 0;
            try {
                Object metadata = field(TextureAtlasSprite.class, "animationMetadata", "field_110982_k").get(sprite);
                if (metadata instanceof net.minecraft.client.resources.data.AnimationMetadataSection) {
                    int index = ((net.minecraft.client.resources.data.AnimationMetadataSection) metadata)
                        .getFrameIndex(0);
                    if (index >= 0 && index < frames) {
                        first = index;
                    }
                }
            } catch (Throwable ignored) {
            }
            TextureUtil.uploadTextureMipmap(
                sprite.getFrameTextureData(first),
                sprite.getIconWidth(),
                sprite.getIconHeight(),
                sprite.getOriginX(),
                sprite.getOriginY(),
                false,
                false
            );
            field(TextureAtlasSprite.class, "frameCounter", "field_110973_g").setInt(sprite, 0);
            field(TextureAtlasSprite.class, "tickCounter", "field_110983_h").setInt(sprite, 0);
            return true;
        } catch (Throwable t) {
            GtnhCalcOracleMod.LOG.warn("Could not show the first frame of " + sprite.getIconName() + ".", t);
            return false;
        }
    }

    private static Field field(Class<?> type, String deobfName, String srgName) throws NoSuchFieldException {
        for (String name : new String[] { deobfName, srgName }) {
            try {
                Field field = type.getDeclaredField(name);
                field.setAccessible(true);
                return field;
            } catch (NoSuchFieldException ignored) {
            }
        }
        throw new NoSuchFieldException(type.getName() + "." + deobfName);
    }
}
