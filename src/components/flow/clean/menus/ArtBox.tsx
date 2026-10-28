import { ResourceIcon } from "@/components/nei/ResourceIcon";

/**
 * An item or block picture at a hard size, zoomed INTO the sprite: the rendered sprites are 256 px canvases whose
 * block fills only the middle ~45%, so the image is drawn at 220% of its window and the margin cropped away.
 */
export function ArtBox({
  src,
  atlas,
  size = 20,
  alt = "",
}: {
  src?: string;
  atlas?: { id: string; displayName?: string; iconAtlas?: unknown; dominantColor?: string };
  size?: number;
  alt?: string;
}) {
  return (
    <span className="cm-icon" style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", width: size, height: size }}>
      {src ? (
        <img src={src} alt={alt} draggable={false} className="minecraft-pixel-art" style={{ width: "220%", height: "220%", maxWidth: "none", flex: "none", objectFit: "contain" }} />
      ) : atlas ? (
        <ResourceIcon
          resource={{ kind: "item", amount: 1, displayName: atlas.displayName ?? atlas.id, ...(atlas as object) } as never}
          bare
          tooltip={false}
          showAmount={false}
          showConsumedState={false}
          iconPixelSize={size * 2.2}
        />
      ) : null}
    </span>
  );
}
