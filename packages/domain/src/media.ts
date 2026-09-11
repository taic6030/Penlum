import { Service } from './service';
import { fail, id, now, hash } from '../../shared/src/index';
export function imageInfo(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return { mime: 'image/png', width: view.getUint32(16), height: view.getUint32(20) };
  if (bytes.length > 10 && String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/))
    return { mime: 'image/gif', width: view.getUint16(6, true), height: view.getUint16(8, true) };
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1];
      const length = view.getUint16(offset + 2);
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker))
        return {
          mime: 'image/jpeg',
          height: view.getUint16(offset + 5),
          width: view.getUint16(offset + 7),
        };
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return fail(422, 'invalid_image', 'Use a valid PNG, JPEG or GIF image');
}
export async function upload(service: Service, siteId: string, file: File, alt: string) {
  await service.access('media:write', siteId);
  if (file.size > 10 * 1024 * 1024 || file.size === 0)
    fail(413, 'file_size', 'Images must be between 1 byte and 10 MB');
  if (alt.length > 1000) fail(422, 'alt', 'Alt text is too long');
  const bytes = await file.arrayBuffer();
  const info = imageInfo(new Uint8Array(bytes));
  if (
    file.type !== info.mime ||
    !info.width ||
    !info.height ||
    info.width > 20000 ||
    info.height > 20000
  )
    fail(422, 'invalid_image', 'MIME type or image dimensions are invalid');
  const mediaId = id();
  const key = `${siteId}/media/${mediaId}`;
  const filename = file.name.replace(/[^\p{L}\p{N}._ -]/gu, '').slice(0, 200) || 'image';
  const checksum = await hash(bytes);
  await service.env.MEDIA.put(key, bytes, {
    httpMetadata: { contentType: info.mime },
    customMetadata: { site_id: siteId },
  });
  const data = {
    id: mediaId,
    site_id: siteId,
    r2_key: key,
    filename,
    ...info,
    bytes: file.size,
    alt,
    checksum,
  };
  try {
    await service.commit(
      [
        service.env.DB.prepare(
          'INSERT INTO media(id,site_id,r2_key,filename,mime,width,height,bytes,alt,checksum,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).bind(
          mediaId,
          siteId,
          key,
          filename,
          info.mime,
          info.width,
          info.height,
          file.size,
          alt,
          checksum,
          now(),
        ),
        service.audit(siteId, 'media.upload', mediaId, null, data),
      ],
      siteId,
    );
  } catch (e) {
    await service.env.MEDIA.delete(key);
    throw e;
  }
  return { ...data, url: `/media/${mediaId}` };
}
