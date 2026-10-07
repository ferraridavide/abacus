/** Grab a poster frame + metadata from a local video file, entirely in the browser. */
export function probeVideo(file: File): Promise<{ thumb: Blob | null; width: number; height: number; duration: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;
    const done = (thumb: Blob | null) => {
      const res = { thumb, width: video.videoWidth, height: video.videoHeight, duration: video.duration || 0 };
      URL.revokeObjectURL(url);
      resolve(res);
    };
    const timer = setTimeout(() => done(null), 8000);
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, (video.duration || 0) / 3);
    };
    video.onseeked = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 1280 / (video.videoWidth || 1));
        canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
        canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
        canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => done(b), 'image/jpeg', 0.85);
      } catch {
        done(null);
      }
    };
    video.onerror = () => {
      clearTimeout(timer);
      done(null);
    };
  });
}

export function isVideoFile(file: File) {
  return file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv|mkv)$/i.test(file.name);
}
