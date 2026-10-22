import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { PROOF_JPEG_QUALITY, proofResize } from './photoSize';

/**
 * A proof photo made small before it is uploaded: longest side at most PROOF_MAX_EDGE, JPEG. A 12 MP camera photo
 * (3-5 MB) becomes a few hundred KB, which uploads in seconds on a weak signal. If resizing fails, the original is sent.
 */
export async function prepareProofPhoto(uri: string, width?: number, height?: number): Promise<{ uri: string; mimeType: string }> {
  try {
    const context = ImageManipulator.manipulate(uri);
    const resize = proofResize(width, height);
    if (resize) context.resize(resize);
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ compress: PROOF_JPEG_QUALITY, format: SaveFormat.JPEG });
    return { uri: saved.uri, mimeType: 'image/jpeg' };
  } catch {
    return { uri, mimeType: 'image/jpeg' };
  }
}
