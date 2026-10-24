import { clientAddress, countEvents, recordEvents, saltedKey, serially } from "./community";

/**
 * What stands between an anonymous board-image upload and the public bucket.
 * Anyone may put a picture on their board without an account, so the only
 * identity is the address, and the address alone must not be able to fill
 * the project's storage: each address has an hour's and a day's share, and
 * the whole site has its own, so a thousand addresses cannot either. The
 * numbers are a worst case of 1.6 GB a day at the 4 MB cap; a board
 * screenshot is 100 to 300 KB, so a normal day is tens of MB.
 */

export const IMAGES_PER_HOUR = 30;
export const IMAGES_PER_DAY = 60;
export const SITE_IMAGES_PER_HOUR = 120;
export const SITE_IMAGES_PER_DAY = 400;

const ACTION = "image_upload";
const SITE_KEY = "images:site";
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** Why an upload may not land, as the player is told. */
export type ImageRefusal = { status: number; error: string };

/**
 * Checks the four counts and, when all are under their limit, records the
 * upload against the address and the site before answering, so the upload it
 * goes on to make is already counted. One at a time, so two uploads cannot
 * both read a count under its limit.
 */
export function claimImageUpload(request: Request): Promise<ImageRefusal | undefined> {
  const address = `images:address:${saltedKey(clientAddress(request))}`;
  return serially(SITE_KEY, async () => {
    const [addressHour, addressDay, siteHour, siteDay] = await Promise.all([
      countEvents(address, ACTION, HOUR),
      countEvents(address, ACTION, DAY),
      countEvents(SITE_KEY, ACTION, HOUR),
      countEvents(SITE_KEY, ACTION, DAY),
    ]);
    if (addressHour >= IMAGES_PER_HOUR) {
      return { status: 429, error: "Too many image uploads: try again in a little while." };
    }
    if (addressDay >= IMAGES_PER_DAY) {
      return { status: 429, error: "That is a lot of images for one day. Try again tomorrow." };
    }
    // A site cap biting is the owner's to know: every anonymous paste, drop
    // and picture key answers this until the window passes, and the numbers
    // can only be raised with that in the log.
    if (siteDay >= SITE_IMAGES_PER_DAY) {
      console.warn(`images: the site's ${SITE_IMAGES_PER_DAY} a day are used; uploads refused until tomorrow`);
      return { status: 503, error: "Lots of images have been uploaded today. Try again tomorrow." };
    }
    if (siteHour >= SITE_IMAGES_PER_HOUR) {
      console.warn(`images: the site's ${SITE_IMAGES_PER_HOUR} an hour are used; uploads refused for the hour`);
      return { status: 503, error: "Lots of images are being uploaded right now. Try again in an hour." };
    }
    await recordEvents([
      { actorKey: address, action: ACTION },
      { actorKey: SITE_KEY, action: ACTION },
    ]);
    return undefined;
  });
}
