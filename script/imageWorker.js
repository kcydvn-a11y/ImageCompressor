// script/imageWorker.js  (Version 2.0 - High Performance)
self.onmessage = async (e) => {
    const {
        imageBitmap,          // Ưu tiên nhận ImageBitmap (nhanh hơn dataUrl rất nhiều)
        imageDataUrl,         // Fallback nếu không có ImageBitmap
        quality = 0.8,
        targetWidth,
        targetHeight,
        fileType = 'image/webp',
        compressionLevel = 6,
        maxDimension = 16384
    } = e.data;

    let bitmap = imageBitmap;

    try {
        // 1. Load ảnh thông minh
        if (!bitmap && imageDataUrl) {
            const img = new Image();
            img.src = imageDataUrl;

            await Promise.race([
                new Promise((resolve, reject) => {
                    img.onload = () => resolve();
                    img.onerror = () => reject(new Error('Không thể tải ảnh'));
                }),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Timeout tải ảnh (8s)')), 8000)
                )
            ]);

            // Chuyển sang ImageBitmap để xử lý nhanh hơn
            bitmap = await createImageBitmap(img);
        }

        if (!bitmap) throw new Error('Không có dữ liệu ảnh hợp lệ');

        // 2. Tính kích thước thông minh + giữ tỷ lệ
        const srcW = bitmap.width;
        const srcH = bitmap.height;
        const aspect = srcW / srcH;

        let frameW = Math.min(Math.max(targetWidth || srcW, 1), maxDimension);
        let frameH = Math.min(Math.max(targetHeight || srcH, 1), maxDimension);

        let drawW = frameW;
        let drawH = frameH;

        if (targetWidth || targetHeight) {
            if (aspect > 1) {
                drawH = frameW / aspect;
                if (drawH > frameH) {
                    drawH = frameH;
                    drawW = frameH * aspect;
                }
            } else {
                drawW = frameH * aspect;
                if (drawW > frameW) {
                    drawW = frameW;
                    drawH = frameW / aspect;
                }
            }
        } else {
            drawW = srcW;
            drawH = srcH;
            frameW = srcW;
            frameH = srcH;
        }

        // 3. Tạo OffscreenCanvas hiệu suất cao
        const canvas = new OffscreenCanvas(Math.round(frameW), Math.round(frameH));
        const ctx = canvas.getContext('2d', {
            alpha: fileType === 'image/png' || fileType === 'image/tiff' || fileType === 'image/webp',
            willReadFrequently: false
        });

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // Tô nền trắng cho JPEG/BMP
        if (fileType === 'image/jpeg' || fileType === 'image/jpg' || fileType === 'image/bmp') {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        const offsetX = (canvas.width - drawW) / 2;
        const offsetY = (canvas.height - drawH) / 2;
        ctx.drawImage(bitmap, offsetX, offsetY, drawW, drawH);

        // Giải phóng bitmap sớm để giảm RAM
        if (bitmap.close) bitmap.close();

        // 4. Nén theo từng định dạng (thông minh)
        let blob;
        const q = Math.max(0.1, Math.min(1, quality));

        switch (fileType) {
            case 'image/png':
                // Ưu tiên UPNG.js (mạnh nhất) → pako → native
                if (typeof UPNG !== 'undefined') {
                    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const png = UPNG.encode([imgData.data.buffer], canvas.width, canvas.height, 0);
                    blob = new Blob([png], { type: 'image/png' });
                } else if (typeof pako !== 'undefined') {
                    const raw = await canvas.convertToBlob({ type: 'image/png' });
                    const buffer = await raw.arrayBuffer();
                    const compressed = pako.deflate(new Uint8Array(buffer), {
                        level: Math.min(compressionLevel, 9),
                        memLevel: 9
                    });
                    blob = new Blob([compressed], { type: 'image/png' });
                } else {
                    blob = await canvas.convertToBlob({ type: 'image/png' });
                }
                break;

            case 'image/webp':
                blob = await canvas.convertToBlob({ type: 'image/webp', quality: q });
                break;

            case 'image/jpeg':
            case 'image/jpg':
                blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
                break;

            case 'image/tiff':
                if (typeof UTIF === 'undefined') throw new Error('Thiếu thư viện UTIF.js');
                const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
                const tiff = UTIF.encodeImage(rgba, canvas.width, canvas.height);
                blob = new Blob([tiff], { type: 'image/tiff' });
                break;

            case 'image/bmp':
                blob = await createBMP(ctx, canvas.width, canvas.height, compressionLevel > 0);
                break;

            default:
                blob = await canvas.convertToBlob({ type: 'image/webp', quality: q });
        }

        // 5. Trả kết quả
        const arrayBuffer = await blob.arrayBuffer();

        self.postMessage({
            success: true,
            blob: arrayBuffer,
            size: blob.size,
            width: Math.round(drawW),
            height: Math.round(drawH),
            type: blob.type
        }, [arrayBuffer]); // Transferable → không copy → rất nhanh

    } catch (err) {
        self.postMessage({
            success: false,
            error: err.message || 'Lỗi không xác định'
        });
    }
};

// ==================== BMP Encoder tối ưu ====================
async function createBMP(ctx, width, height, useRLE = false) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const bytesPerPixel = 3;
    const rowSize = Math.ceil((width * bytesPerPixel) / 4) * 4;

    const fileHeader = new Uint8Array(14);
    fileHeader[0] = 0x42; // B
    fileHeader[1] = 0x4D; // M
    fileHeader[10] = 54;

    const dibHeader = new Uint8Array(40);
    dibHeader[0] = 40;
    new Uint32Array(dibHeader.buffer)[1] = width;
    new Uint32Array(dibHeader.buffer)[2] = height;
    dibHeader[12] = 1;
    dibHeader[14] = 24;

    let pixelData;

    if (useRLE) {
        // RLE đơn giản (tốt cho ảnh có nhiều vùng màu giống nhau)
        const rows = [];
        for (let y = height - 1; y >= 0; y--) {
            const row = [];
            let run = 1;
            let last = null;

            for (let x = 0; x < width; x++) {
                const i = (y * width + x) * 4;
                const pixel = [data[i + 2], data[i + 1], data[i]]; // BGR

                if (last && pixel[0] === last[0] && pixel[1] === last[1] && pixel[2] === last[2] && run < 255) {
                    run++;
                } else {
                    if (last) row.push(run, ...last);
                    last = pixel;
                    run = 1;
                }
            }
            if (last) row.push(run, ...last);
            row.push(0, 0); // EOL
            rows.push(...row);
        }
        rows.push(0, 1); // EOB
        pixelData = new Uint8Array(rows);
    } else {
        pixelData = new Uint8Array(rowSize * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const src = (y * width + x) * 4;
                const dst = (height - 1 - y) * rowSize + x * 3;
                pixelData[dst]     = data[src + 2]; // B
                pixelData[dst + 1] = data[src + 1]; // G
                pixelData[dst + 2] = data[src];     // R
            }
        }
    }

    const fileSize = 14 + 40 + pixelData.length;
    new Uint32Array(fileHeader.buffer)[1] = fileSize;

    return new Blob([fileHeader, dibHeader, pixelData], { type: 'image/bmp' });
}