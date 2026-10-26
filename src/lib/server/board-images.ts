/** A board image's month folder, as the upload names it (`YYYY-MM`). */
export const BOARD_IMAGE_MONTH = /^\d{4}-\d{2}$/;

/** A board image's file name: 18 random hex characters and the sniffed format's extension. */
export const BOARD_IMAGE_NAME = /^[0-9a-f]{18}\.(png|jpg|gif|webp)$/;

/** The content type each servable extension is answered with. */
export const BOARD_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
