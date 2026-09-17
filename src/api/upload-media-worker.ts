/** 在独立线程读取图片尺寸和视频时长，避免损坏文件阻塞 CLI。@author xiuyu.yi */
import { open } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import mediaInfoFactory from 'mediainfo.js';
import { imageDimensionsFromStream } from 'image-dimensions';

if (workerData.image) {
  const image = await imageDimensionsFromStream((await openAsBlob(workerData.path)).stream());
  parentPort?.postMessage({ ...image, hasVideo: false });
} else {
  const file = await open(workerData.path, 'r');
  try {
    const media = await mediaInfoFactory({ format: 'object' });
    try {
      const result = await media.analyzeData((await file.stat()).size, async (size, offset) => {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await file.read(buffer, 0, size, offset);
        return buffer.subarray(0, bytesRead);
      });
      const tracks = result.media?.track ?? [];
      const video = tracks.find((track) => track['@type'] === 'Video');
      const general = tracks.find((track) => track['@type'] === 'General');
      parentPort?.postMessage({
        duration: general?.Duration ?? video?.Duration,
        hasVideo: Boolean(video),
      });
    } finally {
      media.close();
    }
  } finally {
    await file.close();
  }
}
