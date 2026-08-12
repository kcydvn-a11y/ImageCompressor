const imageInput = document.getElementById('imageInput');
const uploadArea = document.getElementById('uploadArea');
const qualityInput = document.getElementById('quality');
const qualityValue = document.getElementById('qualityValue');
const resizeWidth = document.getElementById('resizeWidth');
const resizeHeight = document.getElementById('resizeHeight');
const ppiSelect = document.getElementById('ppiSelect');
const tableBody = document.getElementById('tableBody');
const imageTable = document.getElementById('imageTable');
const preview = document.getElementById('preview');
const previewSection = document.getElementById('previewSection');
const previewOriginalImg = document.getElementById('previewOriginalImg');
const previewCompressedImg = document.getElementById('previewCompressedImg');
const slider = document.getElementById('slider');
const sliderContainer = document.getElementById('sliderContainer');
const previewOriginalSize = document.getElementById('previewOriginalSize');
const previewCompressedSize = document.getElementById('previewCompressedSize');
const sizeSummary = document.getElementById('sizeSummary');
const totalOriginalSize = document.getElementById('totalOriginalSize');
const totalCompressedFooter = document.getElementById('totalCompressedFooter');
const reductionPercent = document.getElementById('reductionPercent');
const notification = document.getElementById('notification');
const controls = document.getElementById('controls');
const loading = document.getElementById('loading');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingProgress = document.getElementById('loadingProgress');
const loadingMessage = document.getElementById('loadingMessage');
const rotatePopup = document.getElementById('rotatePopup');
const rotateCanvas = document.getElementById('rotateCanvas');
const cropPopup = document.getElementById('cropPopup');
const cropCanvas = document.getElementById('cropCanvas');
const cropOverlay = document.getElementById('cropOverlay');
const rulerHorizontal = document.getElementById('rulerHorizontal');
const rulerVertical = document.getElementById('rulerVertical');
const customAngle = document.getElementById('customAngle');

const MAX_WIDTH = 800;
let imagesData = [];
let currentIndex = -1;
let allCompressed = false;
let currentRotation = 0;
let cropData = { x: 0, y: 0, width: 0, height: 0, isDragging: false, isResizing: false, handle: null };
let originalImagesData = [];
let inputUnit = { width: 'px', height: 'px' };

// Worker Pool để xử lý song song
class WorkerPool {
    constructor(size) {
        this.size = Math.min(size, navigator.hardwareConcurrency || 4);
        this.workers = [];
        this.taskQueue = [];
        this.availableWorkers = [];
        this.init();
    }

    init() {
        for (let i = 0; i < this.size; i++) {
            const worker = new Worker(URL.createObjectURL(new Blob([workerCode], { type: 'application/javascript' })));
            worker.id = i;
            this.workers.push(worker);
            this.availableWorkers.push(worker);
        }
    }

    enqueueTask(task) {
        return new Promise((resolve, reject) => {
            this.taskQueue.push({ task, resolve, reject });
            this.processQueue();
        });
    }

    processQueue() {
        if (this.taskQueue.length === 0 || this.availableWorkers.length === 0) return;
        const { task, resolve, reject } = this.taskQueue.shift();
        const worker = this.availableWorkers.shift();
        worker.onmessage = (e) => {
            if (e.data.error) reject(e.data.error);
            else resolve(e.data);
            this.availableWorkers.push(worker);
            this.processQueue();
        };
        worker.onerror = (error) => {
            reject(error);
            this.availableWorkers.push(worker);
            this.processQueue();
        };
        worker.postMessage(task);
    }

    terminate() {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
        this.availableWorkers = [];
    }
}

let workerPool = null;
const workerCode = `
    function calculateImageEntropy(imageData) {
        const data = imageData.data;
        const histogram = new Uint32Array(256).fill(0);
        for (let i = 0; i < data.length; i += 4) {
            const gray = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
            histogram[gray]++;
        }
        let entropy = 0;
        const total = data.length / 4;
        for (let i = 0; i < 256; i++) {
            if (histogram[i] > 0) {
                const p = histogram[i] / total;
                entropy -= p * Math.log2(p);
            }
        }
        return entropy;
    }

    function optimizeQuality(entropy, baseQuality) {
        const minQuality = 0.5;
        const entropyFactor = Math.min(entropy / 8, 1);
        return Math.max(minQuality, Math.min(baseQuality * (1 + entropyFactor * 0.2), 1));
    }

    async function progressiveCompress(canvas, fileType, baseQuality, targetWidth, targetHeight) {
        let low = 0.5, high = Math.min(baseQuality, 1);
        let bestResult = null;
        const targetSize = 1024 * 1024;

        while (low <= high) {
            const mid = (low + high) / 2;
            const blob = await canvas.convertToBlob({ type: fileType, quality: mid });
            const size = blob.size;

            if (!bestResult || size < bestResult.size) {
                bestResult = { blob, quality: mid, size };
            }

            if (size <= targetSize || Math.abs(high - low) < 0.05) break;
            if (size > targetSize) high = mid - 0.05;
            else low = mid + 0.05;
        }

        return bestResult || { blob: await canvas.convertToBlob({ type: fileType, quality: baseQuality }), quality: baseQuality };
    }

    self.onmessage = async function(e) {
        const { imageBitmap, quality, fileType, targetWidth, targetHeight } = e.data;
        try {
            const canvas = new OffscreenCanvas(targetWidth, targetHeight);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.imageSmoothingQuality = 'high';

            if (!imageBitmap) {
                throw new Error('No valid image source provided');
            }

            let outputType = fileType === 'image/bmp' ? 'image/png' : fileType;
            const isJpg = (outputType === 'image/jpeg' || outputType === 'image/jpg');

            // 1. Tính kích thước hiển thị theo đúng tỷ lệ khung hình
            const aspectRatio = imageBitmap.width / imageBitmap.height;
            let newWidth = targetWidth;
            let newHeight = targetHeight;
            if (targetWidth || targetHeight) {
                if (aspectRatio > 1) {
                    newWidth = targetWidth;
                    newHeight = targetWidth / aspectRatio;
                } else {
                    newHeight = targetHeight;
                    newWidth = targetHeight * aspectRatio;
                }
            }

            const offsetX = (canvas.width - newWidth) / 2;
            const offsetY = (canvas.height - newHeight) / 2;

            // 2. Dọn sạch Canvas
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // 3. Tô nền trắng chỉ khi file xuất ra là JPG/JPEG
            if (isJpg) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }

            // 4. Vẽ ảnh 1 lần duy nhất lên Canvas
            ctx.drawImage(imageBitmap, offsetX, offsetY, newWidth, newHeight);

            // 5. Tính toán entropy & nén ảnh
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const entropy = calculateImageEntropy(imageData);
            const optimizedQuality = optimizeQuality(entropy, quality);

            const result = await progressiveCompress(canvas, outputType, optimizedQuality, newWidth, newHeight);
            const arrayBuffer = await result.blob.arrayBuffer();

            self.postMessage({
                blob: arrayBuffer,
                size: result.size,
                width: Math.round(newWidth),
                height: Math.round(newHeight),
                quality: result.quality
            }, [arrayBuffer]);

            if (imageBitmap) imageBitmap.close();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        } catch (error) {
            self.postMessage({ error: error.message });
        }
    };
`;

if (typeof Worker !== 'undefined') {
    try {
        workerPool = new WorkerPool(navigator.hardwareConcurrency || 4);
    } catch (error) {
        console.error('Failed to initialize Worker Pool:', error);
        showNotification(languages[currentLanguage].notifications.error + 'Worker Pool initialization failed.');
    }
}

const languages = {
    vi: {
        title: "Nén Ảnh Offline Chuyên Nghiệp - International",
        headerTitle: "Công cụ tối ưu hóa hình ảnh",
        description1: "Hỗ trợ nén giữ nguyên định dạng: JPEG, PNG, GIF, WebP, BMP, TIFF, HEIC với chất lượng cao.",
        description2: "Tải lên ảnh, đợi nén hoàn tất, dùng thanh kéo để so sánh.",
        uploadText: "Kéo thả ảnh vào đây hoặc nhấp để chọn",
        totalOriginal: "Tổng dung lượng gốc: ",
        totalCompressed: "Tổng đã nén: ",
        compareTitle: "So sánh Ảnh",
        originalLabel: "Gốc",
        compressedLabel: "Nén",
        loading: "Đang xử lý...",
        qualityLabel: "Chất lượng (%):",
        widthLabel: "Rộng:",
        heightLabel: "Dài:",
        widthPlaceholder: "Gốc (px hoặc inch)",
        heightPlaceholder: "Gốc (px hoặc inch)",
        compressAllBtn: "Nén Tất Cả",
        saveAllBtn: "Lưu Tất Cả Ảnh",
        removeBtn: "Xóa",
        rotateBtn: "Xoay Ảnh",
        cropBtn: "Cắt Ảnh",
        rotateTitle: "Xoay Ảnh",
        cropTitle: "Cắt Ảnh",
        resetImageBtn: "Khôi Phục Ảnh",
        resetAllBtn: "Khôi Phục Tất Cả",
        previewBtn: "Xem Trước",
        ResetBtn: "Đặt lại",
        applyBtn: "Áp Dụng",
        footerText: "Viết bởi ThaiThongSj@gmail.com",

        // ===== PPI & Tooltip =====
        ppiLabel: "PPI:",
        ppiTitle: "Chọn độ phân giải (Pixels Per Inch) cho ảnh khi in",
        ppi300: "300 PPI – Chất lượng in tiêu chuẩn (Standard print)",
        ppi326: "326 PPI – Độ phân giải màn hình Retina (iPhone, iPad...)",
        ppi600: "600 PPI – Chất lượng in cao (High quality print)",
        ppi1200: "1200 PPI – Chất lượng in chuyên nghiệp / ảnh lớn",

        qualityTitle: "Chất lượng nén (càng cao càng ít mất chi tiết nhưng file càng lớn)",
        widthTitle: "Chiều rộng mong muốn (px hoặc inch). Để trống = giữ tỷ lệ gốc",
        heightTitle: "Chiều cao mong muốn (px hoặc inch). Để trống = giữ tỷ lệ gốc",
        rotateBtnTitle: "Xoay và lật ảnh",
        cropBtnTitle: "Cắt ảnh theo vùng chọn",
        ResetBtnTitle: "Đặt lại góc xoay và lật về ban đầu",
        applyBtnTitle: "Áp dụng thay đổi xoay/lật",
        resetImageBtnTitle: "Khôi phục ảnh gốc (bỏ hết chỉnh sửa)",
        previewBtnTitle: "Xem trước góc xoay tùy chỉnh",

        notifications: {
            loaded: "Đã tải xong tất cả ảnh!",
            compressing: "Đang nén tất cả ảnh...",
            compressed: "Đã nén xong tất cả ảnh!",
            notProcessed: "Chưa có ảnh nào được xử lý!",
            savedSingle: "Đã lưu ảnh!",
            saved: "Đã lưu tất cả ảnh vào thư mục!",
            error: "Lỗi nén ảnh: ",
            removed: "Đã xóa ảnh khỏi danh sách!",
            rotated: "Đã xoay ảnh thành công!",
            cropped: "Đã cắt ảnh thành công!",
            resetImage: "Đã khôi phục ảnh gốc!",
            resetAll: "Đã khôi phục tất cả ảnh gốc!",
            invalidAngle: "Góc xoay không hợp lệ!",
            invalidCrop: "Vùng cắt không hợp lệ!",
            invalidFile: "File không hợp lệ: ",
        },
        table: {
            notResized: "Chưa resize",
            notCompressed: "Chưa nén",
            unchanged: "Giữ nguyên",
            notCompressedLabel: "(Chưa nén)"
        },
        preview: {
            unchanged: "(Giữ nguyên)",
            notCompressed: "Chưa nén"
        },
        summary: {
            images: "ảnh",
            saved: "Tiết kiệm",
            increased: "Tăng"
        },
        tableHeaders: {
            fileName: "Tên Hình",
            originalSize: "Kích thước Gốc",
            originalFileSize: "Dung lượng Gốc",
            resizedSize: "Kích thước Resize",
            compressedSize: "Dung lượng Nén"
        }
    },

    en: {
        title: "Professional Offline Image Compression - International",
        headerTitle: "Image Optimization Tool",
        description1: "Supports compression while preserving formats: JPEG, PNG, GIF, WebP, BMP, TIFF, HEIC with high quality.",
        description2: "Upload images, wait for compression to complete, and use the slider to compare.",
        uploadText: "Drag and drop images here or click to select",
        totalOriginal: "Total original size: ",
        totalCompressed: "Total compressed: ",
        compareTitle: "Compare Images",
        originalLabel: "Original",
        compressedLabel: "Compressed",
        loading: "Processing...",
        qualityLabel: "Quality (%):",
        widthLabel: "Width:",
        heightLabel: "Height:",
        widthPlaceholder: "Original (px or inch)",
        heightPlaceholder: "Original (px or inch)",
        compressAllBtn: "Compress All",
        saveAllBtn: "Save All Images",
        removeBtn: "Remove",
        rotateBtn: "Rotate Image",
        cropBtn: "Crop Image",
        rotateTitle: "Rotate Image",
        cropTitle: "Crop Image",
        resetImageBtn: "Reset Image",
        resetAllBtn: "Reset All Images",
        previewBtn: "Preview",
        ResetBtn: "Reset",
        applyBtn: "Apply",
        footerText: "Developed by ThaiThongSj@gmail.com",

        // ===== PPI & Tooltip =====
        ppiLabel: "PPI:",
        ppiTitle: "Select resolution (Pixels Per Inch) for printing",
        ppi300: "300 PPI – Standard print quality",
        ppi326: "326 PPI – Retina display resolution (iPhone, iPad...)",
        ppi600: "600 PPI – High quality print",
        ppi1200: "1200 PPI – Professional / large format print",

        qualityTitle: "Compression quality (higher = less detail loss but larger file)",
        widthTitle: "Desired width (px or inch). Leave empty to keep original ratio",
        heightTitle: "Desired height (px or inch). Leave empty to keep original ratio",
        rotateBtnTitle: "Rotate and flip image",
        cropBtnTitle: "Crop image to selected area",
        ResetBtnTitle: "Reset rotation and flip to original",
        applyBtnTitle: "Apply rotation/flip changes",
        resetImageBtnTitle: "Restore original image (discard all edits)",
        previewBtnTitle: "Preview custom rotation angle",

        notifications: {
            loaded: "All images have been loaded!",
            compressing: "Compressing all images...",
            compressed: "All images have been compressed!",
            notProcessed: "No images have been processed yet!",
            savedSingle: "Image has been saved!",
            saved: "All images have been saved to a folder!",
            error: "Image compression error: ",
            removed: "Image removed from the list!",
            rotated: "Image rotated successfully!",
            cropped: "Image cropped successfully!",
            resetImage: "Image restored to original!",
            resetAll: "All images restored to original!",
            invalidAngle: "Invalid rotation angle!",
            invalidCrop: "Invalid crop area!",
            invalidFile: "Invalid file: ",
        },
        table: {
            notResized: "Not resized",
            notCompressed: "Not compressed",
            unchanged: "Unchanged",
            notCompressedLabel: "(Not compressed)"
        },
        preview: {
            unchanged: "(Unchanged)",
            notCompressed: "Not compressed"
        },
        summary: {
            images: "images",
            saved: "Saved",
            increased: "Increased"
        },
        tableHeaders: {
            fileName: "File Name",
            originalSize: "Original Size",
            originalFileSize: "Original File Size",
            resizedSize: "Resized Size",
            compressedSize: "Compressed Size"
        }
    },

    fr: {
        title: "Compression d'Images Hors Ligne Professionnelle - International",
        headerTitle: "Outil d'optimisation d'images",
        description1: "Supporte la compression tout en préservant les formats : JPEG, PNG, GIF, WebP, BMP, TIFF, HEIC avec une haute qualité.",
        description2: "Téléchargez des images, attendez la fin de la compression, utilisez le curseur pour comparer.",
        uploadText: "Glissez-déposez les images ici ou cliquez pour sélectionner",
        totalOriginal: "Taille totale originale : ",
        totalCompressed: "Taille totale compressée : ",
        compareTitle: "Comparer les Images",
        originalLabel: "Original",
        compressedLabel: "Compressé",
        loading: "Traitement en cours...",
        qualityLabel: "Qualité (%):",
        widthLabel: "Largeur :",
        heightLabel: "Hauteur :",
        widthPlaceholder: "Original (px ou pouce)",
        heightPlaceholder: "Original (px ou pouce)",
        compressAllBtn: "Compresser Tout",
        saveAllBtn: "Sauvegarder Toutes les Images",
        removeBtn: "Supprimer",
        rotateBtn: "Faire Pivoter l'Image",
        cropBtn: "Rogner l'Image",
        rotateTitle: "Faire Pivoter l'Image",
        cropTitle: "Rogner l'Image",
        resetImageBtn: "Restaurer l'Image",
        resetAllBtn: "Restaurer Toutes les Images",
        previewBtn: "Aperçu",
        ResetBtn: "Réinitialiser",
        applyBtn: "Appliquer",
        footerText: "Développé par ThaiThongSj@gmail.com",

        // ===== PPI & Tooltip =====
        ppiLabel: "PPI :",
        ppiTitle: "Sélectionnez la résolution (Pixels Per Inch) pour l'impression",
        ppi300: "300 PPI – Qualité d'impression standard",
        ppi326: "326 PPI – Résolution écran Retina (iPhone, iPad...)",
        ppi600: "600 PPI – Impression haute qualité",
        ppi1200: "1200 PPI – Impression professionnelle / grand format",

        qualityTitle: "Qualité de compression (plus élevé = moins de perte de détails mais fichier plus lourd)",
        widthTitle: "Largeur souhaitée (px ou pouce). Laisser vide = conserver le ratio original",
        heightTitle: "Hauteur souhaitée (px ou pouce). Laisser vide = conserver le ratio original",
        rotateBtnTitle: "Faire pivoter et retourner l'image",
        cropBtnTitle: "Rogner l'image selon la zone sélectionnée",
        ResetBtnTitle: "Réinitialiser la rotation et le retournement",
        applyBtnTitle: "Appliquer les modifications de rotation/retournement",
        resetImageBtnTitle: "Restaurer l'image originale (annuler toutes les modifications)",
        previewBtnTitle: "Aperçu de l'angle de rotation personnalisé",

        notifications: {
            loaded: "Toutes les images ont été chargées !",
            compressing: "Compression de toutes les images...",
            compressed: "Toutes les images ont été compressées !",
            notProcessed: "Aucune image n'a encore été traitée !",
            savedSingle: "Image sauvegardée !",
            saved: "Toutes les images ont été sauvegardées dans un dossier !",
            error: "Erreur de compression d'image : ",
            removed: "Image supprimée de la liste !",
            rotated: "Image pivotée avec succès !",
            cropped: "Image rognée avec succès !",
            resetImage: "Image restaurée à l'original !",
            resetAll: "Toutes les images restaurées à l'original !",
            invalidAngle: "Angle de rotation invalide !",
            invalidCrop: "Zone de rognage invalide !",
            invalidFile: "Fichier invalide : ",
        },
        table: {
            notResized: "Non redimensionné",
            notCompressed: "Non compressé",
            unchanged: "Inchangé",
            notCompressedLabel: "(Non compressé)"
        },
        preview: {
            unchanged: "(Inchangé)",
            notCompressed: "Non compressé"
        },
        summary: {
            images: "images",
            saved: "Économisé",
            increased: "Augmenté"
        },
        tableHeaders: {
            fileName: "Nom du Fichier",
            originalSize: "Taille Originale",
            originalFileSize: "Poids Original",
            resizedSize: "Taille Redimensionnée",
            compressedSize: "Poids Compressé"
        }
    }
};

let currentLanguage = 'en';

function switchLanguage(lang) {
    currentLanguage = lang;
    
    // Lưu ngôn ngữ vào localStorage
    localStorage.setItem('preferredLanguage', lang);
    
    updateLanguage();
    
    const select = document.getElementById('langSelect');
    if (select) {
        select.value = lang; // đồng bộ lại giá trị select
        select.style.backgroundImage = `url('${select.options[select.selectedIndex].getAttribute('data-flag')}')`;
    }
    
    if (imagesData.length > 0) {
        for (let i = 0; i < imagesData.length; i++) {
            updateTableRow(i);
        }
        if (currentIndex !== -1) showPreview(currentIndex);
        updateTotalOriginalSize();
        updateTotalCompressedSize();
    }
}
function updateLanguage() {
    const langData = languages[currentLanguage];

    const updateText = (selector, text, icon = null) => {
        const element = document.querySelector(selector);
        if (element) {
            if (icon) {
                element.innerHTML = `<span class="icon">${icon}</span> ${text}`;
            } else {
                element.textContent = text;
            }
        }
    };

    // ===== Text thông thường =====
    updateText('title', langData.title);
    updateText('.header h1', langData.headerTitle);
    updateText('[data-lang="description1"]', langData.description1);
    updateText('[data-lang="description2"]', langData.description2);
    updateText('#uploadArea p', langData.uploadText);
    updateText('.image-box h3', langData.compareTitle);
    updateText('[data-lang="originalLabel"]', langData.originalLabel);
    updateText('[data-lang="compressedLabel"]', langData.compressedLabel);
    updateText('#loading', langData.loading);
    updateText('label[for="quality"]', langData.qualityLabel);
    updateText('label[for="resizeWidth"]', langData.widthLabel);
    updateText('label[for="resizeHeight"]', langData.heightLabel);
    
    if (resizeWidth) resizeWidth.placeholder = langData.widthPlaceholder;
    if (resizeHeight) resizeHeight.placeholder = langData.heightPlaceholder;

    document.querySelectorAll('[data-lang="compressAllBtn"]').forEach(btn => {btn.innerHTML =`⚡ ${langData.compressAllBtn}`;});
    updateText('.save-all-btn', langData.saveAllBtn);
    updateText('.footer-text', langData.footerText);
    updateText('[data-lang="rotateBtn"]', langData.rotateBtn, '⟳');
    updateText('[data-lang="cropBtn"]', langData.cropBtn, '✂');
    updateText('[data-lang="rotateTitle"]', langData.rotateTitle);
    updateText('[data-lang="cropTitle"]', langData.cropTitle);
    updateText('[data-lang="resetAllBtn"]', langData.resetAllBtn);
    updateText('[data-lang="previewBtn"]', langData.previewBtn);
    updateText('[data-lang="ResetBtn"]', langData.ResetBtn);
    updateText('[data-lang="applyBtn"]', langData.applyBtn);
    updateText('[data-lang="resetImageBtn"]', langData.resetImageBtn);

    // Table headers
    updateText('#headerFileName', langData.tableHeaders.fileName);
    updateText('#headerOriginalSize', langData.tableHeaders.originalSize);
    updateText('#headerOriginalFileSize', langData.tableHeaders.originalFileSize);
    updateText('#headerResizedSize', langData.tableHeaders.resizedSize);
    updateText('#headerCompressedSize', langData.tableHeaders.compressedSize);

    // ===== TOOLTIP (rê chuột hiện giải thích) =====
    // Quality
    const qualityLabel = document.querySelector('label[for="quality"]');
    if (qualityLabel) qualityLabel.title = langData.qualityTitle || '';

    // Width / Height
    const widthLabel = document.querySelector('label[for="resizeWidth"]');
    if (widthLabel) widthLabel.title = langData.widthTitle || '';

    const heightLabel = document.querySelector('label[for="resizeHeight"]');
    if (heightLabel) heightLabel.title = langData.heightTitle || '';

    // PPI
    const ppiLabel = document.querySelector('label[for="ppiSelect"]');
    if (ppiLabel) {
        ppiLabel.textContent = langData.ppiLabel || 'PPI:';
        ppiLabel.title = langData.ppiTitle || '';
    }

    const ppiSelectEl = document.getElementById('ppiSelect');
    if (ppiSelectEl) {
        ppiSelectEl.title = langData.ppiTitle || '';
        ppiSelectEl.querySelectorAll('option').forEach(opt => {
            const key = opt.getAttribute('data-lang-title');
            if (key && langData[key]) {
                opt.title = langData[key];
            }
        });
    }

    // Nút Rotate / Crop
    const rotateBtn = document.querySelector('[data-lang="rotateBtn"]');
    if (rotateBtn) {
        rotateBtn.title = langData.rotateBtnTitle || '';
        rotateBtn.onclick = openRotatePopup;
    }

    const cropBtn = document.querySelector('[data-lang="cropBtn"]');
    if (cropBtn) {
        cropBtn.title = langData.cropBtnTitle || '';
        cropBtn.onclick = openCropPopup;
    }

    // Nút trong popup
    const previewBtn = document.querySelector('[data-lang="previewBtn"]');
    if (previewBtn) previewBtn.title = langData.previewBtnTitle || '';

    const resetBtn = document.querySelector('[data-lang="ResetBtn"]');
    if (resetBtn) resetBtn.title = langData.ResetBtnTitle || '';

    const applyBtn = document.querySelector('[data-lang="applyBtn"]');
    if (applyBtn) applyBtn.title = langData.applyBtnTitle || '';

    document.querySelectorAll('[data-lang="resetImageBtn"]').forEach(btn => {
        btn.title = langData.resetImageBtnTitle || '';
    });

    // Nút xóa trong bảng
    document.querySelectorAll('.remove-btn').forEach(btn => {
        if (btn) btn.title = langData.removeBtn;
    });
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function throttle(func, limit) {
    let lastFunc;
    let lastRan;
    return function (...args) {
        if (!lastRan) {
            func.apply(this, args);
            lastRan = Date.now();
        } else {
            clearTimeout(lastFunc);
            lastFunc = setTimeout(() => {
                if ((Date.now() - lastRan) >= limit) {
                    func.apply(this, args);
                    lastRan = Date.now();
                }
            }, limit - (Date.now() - lastRan));
        }
    };
}

uploadArea.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    imageInput.click();
});

imageInput.addEventListener('click', (e) => e.stopPropagation());

uploadArea.addEventListener('dragover', (e) => e.preventDefault());
uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    imageInput.files = e.dataTransfer.files;
    loadImages();
});

imageInput.addEventListener('change', (e) => {
    e.preventDefault();
    e.stopPropagation();
    loadImages();
    imageInput.value = '';
});

qualityInput.min = 20;
qualityInput.max = 100;
qualityInput.value = 80;
qualityInput.addEventListener('input', throttle(() => {
    qualityValue.textContent = `${qualityInput.value}%`;
    updateAllCompressedPreviews();
}, 200));

resizeWidth.addEventListener('input', debounce(() => {
    inputUnit.width = resizeWidth.value.includes('.') ? 'inch' : 'px';
    updateResizeOnly();
}, 300));

resizeHeight.addEventListener('input', debounce(() => {
    inputUnit.height = resizeHeight.value.includes('.') ? 'inch' : 'px';
    updateResizeOnly();
}, 300));

ppiSelect.addEventListener('change', debounce(() => updatePPI(), 300));

async function isValidImageFile(file) {
    const supportedFormats = [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp',
        'image/bmp', 'image/tiff', 'image/tif', 'image/heic', 'image/heif',
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'heic', 'heif'
    ];

    const fileType = file.type || file.name.split('.').pop().toLowerCase();
    if (!supportedFormats.includes(fileType)) {
        return { valid: false, reason: 'Unsupported file type' };
    }

    try {
        const dataUrl = await readFileAsDataURL(file);
        const img = new Image();
        await new Promise((resolve, reject) => {
            img.onload = () => resolve(true);
            img.onerror = () => reject(new Error('Invalid image file'));
            img.src = dataUrl;
        });
        return { valid: true };
    } catch (error) {
        return { valid: false, reason: error.message };
    }
}

async function loadImages() {
    const files = Array.from(imageInput.files);
    if (files.length === 0) return;

    imagesData = [];
    originalImagesData = [];
    tableBody.innerHTML = '';
    imageTable.style.display = 'block';
    previewSection.style.display = 'block';
    controls.style.display = 'flex';
    document.querySelector('.save-all-btn').style.display = 'block';
    loadingOverlay.style.display = 'flex';

    let processedCount = 0;
    const queue = files.map((file, i) => ({ file, index: i }));
    const batchSize = 5;

    const processQueue = async () => {
        if (queue.length === 0) {
            loadingOverlay.style.display = 'none';
            showNotification(languages[currentLanguage].notifications.loaded);
            updateTotalOriginalSize();
            updateTotalCompressedSize();
            return;
        }

        const batch = queue.splice(0, batchSize);
        const promises = batch.map(async ({ file, index }) => {
            let fileType = file.type || file.name.split('.').pop().toLowerCase();
            let dataUrl;

            loadingMessage.textContent = `${languages[currentLanguage].loading} (${file.name.slice(0, 15)}...)`;
            loadingProgress.value = ((processedCount + 1) / files.length) * 100;

            const validation = await isValidImageFile(file);
            const isSupported = validation.valid;

            try {
                if (!isSupported) {
                    showNotification(`${languages[currentLanguage].notifications.invalidFile}${file.name}: ${validation.reason || 'File not supported.'}`);
                    dataUrl = await readFileAsDataURL(file);
                } else if (fileType === 'image/tiff' || fileType === 'image/tif' || file.name.endsWith('.tiff') || file.name.endsWith('.tif')) {
                    dataUrl = await processTiff(file);
                } else if (fileType === 'image/heic' || fileType === 'image/heif' || file.name.endsWith('.heic') || file.name.endsWith('.heif')) {
                    dataUrl = await processHeic(file);
                } else if (fileType === 'image/bmp' || file.name.endsWith('.bmp')) {
                    dataUrl = await processBmp(file);
                } else {
                    dataUrl = await readFileAsDataURL(file);
                }

                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = dataUrl;
                });

                const imgIndex = imagesData.length;
                const row = document.createElement('div');
                row.className = 'table-row';
                row.innerHTML = `
                    <span title="${file.name}">${file.name}</span>
                    <span>${isSupported ? `${img.width}x${img.height}` : 'N/A'}</span>
                    <span>${formatSize(file.size)}</span>
                    <span>${isSupported ? languages[currentLanguage].table.notResized : 'N/A'}</span>
                    <span class="compressed-size">${isSupported ? languages[currentLanguage].table.notCompressed : 'N/A'}</span>
                    <button class="remove-btn" title="${languages[currentLanguage].removeBtn}" onclick="removeImage(${imgIndex}, event)"></button>
                `;
                row.onclick = debounce((e) => {
                    if (e.target.tagName !== 'BUTTON') showPreview(imgIndex);
                }, 300);
                tableBody.appendChild(row);

                const isGIF = fileType === 'image/gif';
                const isWebP = fileType === 'image/webp';
                const isAnimated = (isGIF || isWebP) ? await isAnimatedWebP(file) : false;

                const imageData = {
                    file,
                    originalImage: isSupported ? img : null,
                    originalWidth: isSupported ? img.width : 0,
                    originalHeight: isSupported ? img.height : 0,
                    originalSize: file.size,
                    compressedDataUrl: null,
                    compressedSize: null,
                    resizedDataUrl: null,
                    resizedWidth: null,
                    resizedHeight: null,
                    frameWidth: null,
                    frameHeight: null,
                    isGIF: isGIF || isAnimated,
                    isWebP,
                    originalDataUrl: dataUrl,
                    fileType,
                    isSupported
                };

                imagesData.push(imageData);
                originalImagesData.push({ ...imageData });

                if (imgIndex === 0 && isSupported) {
                    const quality = qualityInput.value / 100;
                    const result = await compressImage(img, quality, dataUrl, null, null, imgIndex);
                    imagesData[0].compressedDataUrl = result.dataUrl;
                    imagesData[0].compressedSize = result.size;
                    updateTableRow(0);
                    showPreview(0);
                }

                processedCount++;
                requestAnimationFrame(() => {
                    updateTotalOriginalSize();
                    updateTotalCompressedSize();
                });
            } catch (error) {
                console.error(`Error processing ${file.name}: ${error.message}`);
                showNotification(`${languages[currentLanguage].notifications.error}${file.name}`);
                const imgIndex = imagesData.length;
                imagesData.push({
                    file,
                    originalImage: null,
                    originalWidth: 0,
                    originalHeight: 0,
                    originalSize: file.size,
                    compressedDataUrl: dataUrl,
                    compressedSize: null,
                    resizedDataUrl: null,
                    resizedWidth: null,
                    resizedHeight: null,
                    frameWidth: null,
                    frameHeight: null,
                    isGIF: fileType === 'image/gif',
                    isWebP: fileType === 'image/webp',
                    originalDataUrl: dataUrl,
                    fileType,
                    isSupported: false
                });
                originalImagesData.push({ ...imagesData[imgIndex] });
                const row = document.createElement('div');
                row.className = 'table-row';
                row.innerHTML = `
                    <span title="${file.name}">${file.name}</span>
                    <span>N/A</span>
                    <span>${formatSize(file.size)}</span>
                    <span>N/A</span>
                    <span class="compressed-size">N/A</span>
                    <button class="remove-btn" title="${languages[currentLanguage].removeBtn}" onclick="removeImage(${imgIndex}, event)"></button>
                `;
                tableBody.appendChild(row);
                processedCount++;
            }
        });

        await Promise.all(promises);
        requestIdleCallback(processQueue, { timeout: 1000 });
    };

    processQueue();
}

function cleanUpMemory(index) {
    if (imagesData[index]) {
        const imgData = imagesData[index];

        if (imgData.compressedDataUrl && imgData.compressedDataUrl !== imgData.originalDataUrl) {
            if (typeof imgData.compressedDataUrl === 'string' && imgData.compressedDataUrl.startsWith('blob:')) {
                URL.revokeObjectURL(imgData.compressedDataUrl);
            }
            imgData.compressedDataUrl = null;
        }

        if (imgData.resizedDataUrl && imgData.resizedDataUrl !== imgData.originalDataUrl) {
            if (typeof imgData.resizedDataUrl === 'string' && imgData.resizedDataUrl.startsWith('blob:')) {
                URL.revokeObjectURL(imgData.resizedDataUrl);
            }
            imgData.resizedDataUrl = null;
        }

        // TUYỆT ĐỐI KHÔNG xóa originalImage hay originalDataUrl ở đây 
        // để người dùng có thể tiếp tục xoay, cắt, chỉnh sửa thoải mái trong suốt phiên làm việc.
    }
}
function removeImage(index, event) {
    event.stopPropagation();
    if (index >= 0 && index < imagesData.length) {
        cleanUpMemory(index);
        imagesData.splice(index, 1);
        originalImagesData.splice(index, 1);
        const rows = tableBody.children;
        tableBody.removeChild(rows[index]);
        showNotification(languages[currentLanguage].notifications.removed);
        if (currentIndex === index) {
            currentIndex = imagesData.length > 0 ? 0 : -1;
            if (currentIndex !== -1) showPreview(currentIndex);
            else preview.style.display = 'none';
        } else if (currentIndex > index) {
            currentIndex--;
        }
        updateTotalOriginalSize();
        updateTotalCompressedSize();
    }
}

function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = () => reject(new Error(`Error reading file ${file.name}`));
        reader.readAsDataURL(file);
    });
}

function processTiff(file) {
    return new Promise((resolve, reject) => {
        if (typeof UTIF === 'undefined') {
            reject(new Error('UTIF library not loaded'));
            return;
        }
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const ifds = UTIF.decode(event.target.result);
                const firstPage = ifds[0];
                UTIF.decodeImage(event.target.result, firstPage);
                const rgba = UTIF.toRGBA8(firstPage);
                const canvas = document.createElement('canvas');
                canvas.width = firstPage.width;
                canvas.height = firstPage.height;
                const ctx = canvas.getContext('2d');
                const imageData = new ImageData(new Uint8ClampedArray(rgba), firstPage.width, firstPage.height);
                ctx.putImageData(imageData, 0, 0);
                resolve(canvas.toDataURL('image/png'));
            } catch (error) {
                reject(error);
            }
        };
        reader.onerror = () => reject(new Error(`Error reading TIFF file ${file.name}`));
        reader.readAsArrayBuffer(file);
    });
}

function processHeic(file) {
    return new Promise((resolve, reject) => {
        if (typeof heic2any === 'undefined') {
            reject(new Error('heic2any library not loaded'));
            return;
        }
        heic2any({ blob: file, toType: 'image/png' })
            .then((blob) => readFileAsDataURL(blob).then(resolve))
            .catch(reject);
    });
}

function processBmp(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error(`Error loading BMP image ${file.name}`));
            img.src = event.target.result;
        };
        reader.onerror = () => reject(new Error(`Error reading BMP file ${file.name}`));
        reader.readAsDataURL(file);
    });
}

async function isAnimatedWebP(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const buffer = event.target.result;
                const view = new DataView(buffer);
                const isAnimated = String.fromCharCode.apply(null, new Uint8Array(buffer, 12, 4)) === 'ANIM';
                resolve(isAnimated);
            } catch (error) {
                resolve(false);
            }
        };
        reader.onerror = () => resolve(false);
        reader.readAsArrayBuffer(file);
    });
}

async function compressAllImages() {
    if (imagesData.length === 0) return;
    showNotification(languages[currentLanguage].notifications.compressing);
    loadingOverlay.style.display = 'flex';
    const quality = qualityInput.value / 100;
    const batchSize = 5;

    const sortedIndices = imagesData.map((_, i) => i).sort((a, b) => {
        return imagesData[a].originalSize - imagesData[b].originalSize;
    });

    const processBatch = async (startIndex) => {
        const endIndex = Math.min(startIndex + batchSize, imagesData.length);
        const promises = [];
        for (let i = startIndex; i < endIndex; i++) {
            const idx = sortedIndices[i];
            const imgData = imagesData[idx];
            if (imgData.isSupported && !imgData.compressedDataUrl && !imgData.isGIF && !(imgData.isWebP && await isAnimatedWebP(imgData.file))) {
                loadingMessage.textContent = `${languages[currentLanguage].notifications.compressing} (${imgData.file.name.slice(0, 15)}...)`;
                loadingProgress.value = ((i + 1) / imagesData.length) * 100;
                const { originalImage, originalDataUrl, frameWidth, frameHeight } = imgData;
                promises.push(compressImage(originalImage, quality, originalDataUrl, frameWidth, frameHeight, idx).then(result => {
                    imgData.compressedDataUrl = result.dataUrl;
                    imgData.compressedSize = result.size;
                    updateTableRow(idx);
                }));
            }
        }
        await Promise.all(promises);
        if (endIndex < imagesData.length) {
            requestIdleCallback(() => processBatch(endIndex), { timeout: 1000 });
        } else {
            loadingOverlay.style.display = 'none';
            updateTotalCompressedSize();
            showNotification(languages[currentLanguage].notifications.compressed);
            if (currentIndex !== -1) showPreview(currentIndex);
            allCompressed = true;
        }
    };

    processBatch(0);
}

async function compressImage(image, quality, originalDataUrl, targetWidth, targetHeight, index) {
    return new Promise((resolve) => {
        try {
            if (!image || !imagesData[index]) {
                resolve({ dataUrl: originalDataUrl, size: imagesData[index]?.originalSize || 0, width: 0, height: 0 });
                return;
            }

            const { isGIF, isWebP, fileType, originalSize, file } = imagesData[index];
            isAnimatedWebP(file).then(async isAnimated => {
                if (isGIF || isAnimated) {
                    resolve({ dataUrl: originalDataUrl, size: originalSize, width: image.width, height: image.height });
                    return;
                }

                createImageBitmap(image).then(bitmap => {
                    const outputType = fileType === 'image/bmp' ? 'image/png' : fileType;
                    
                    // Chuyển bitmap vào mảng Transferable (tham số thứ 2)
                    workerPool.enqueueTask({
                        quality,
                        fileType: outputType,
                        targetWidth: targetWidth || image.width,
                        targetHeight: targetHeight || image.height,
                        imageBitmap: bitmap
                    }, [bitmap]).then(data => {
                        const blob = new Blob([data.blob], { type: outputType });
                        const reader = new FileReader();
                        reader.onload = () => {
                            resolve({
                                dataUrl: reader.result,
                                size: data.size,
                                width: data.width,
                                height: data.height
                            });
                        };
                        reader.readAsDataURL(blob);
                        bitmap.close();
                    }).catch(error => {
                        console.error(`Worker Pool error: ${error}`);
                        bitmap.close();
                        resolve({ dataUrl: originalDataUrl, size: originalSize, width: image.width, height: image.height });
                    });
                }).catch(error => {
                    console.error(`Error creating ImageBitmap: ${error.message}`);
                    resolve({ dataUrl: originalDataUrl, size: originalSize, width: image.width, height: image.height });
                });
            });
        } catch (error) {
            console.error(`Error compressing ${imagesData[index]?.file.name}: ${error.message}`);
            resolve({ dataUrl: originalDataUrl, size: imagesData[index]?.originalSize || 0, width: image?.width || 0, height: image?.height || 0 });
        }
    });
}

async function resizeImage(image, targetWidth, targetHeight, originalDataUrl, index) {
    return new Promise((resolve) => {
        try {
            if (!image || !imagesData[index]) {
                resolve({ dataUrl: originalDataUrl, size: imagesData[index]?.originalSize || 0, width: 0, height: 0 });
                return;
            }

            if (!targetWidth || !targetHeight) {
                resolve({ dataUrl: originalDataUrl, size: imagesData[index].originalSize, width: image.width, height: image.height });
                return;
            }

            // Kiểm tra định dạng ảnh gốc từ mảng dữ liệu
            const fileType = imagesData[index].fileType || '';
            const isJpg = (fileType === 'image/jpeg' || fileType === 'image/jpg' || fileType === 'jpg' || fileType === 'jpeg');
            const outputType = isJpg ? 'image/jpeg' : 'image/png';

            const frameWidth = Math.max(targetWidth, 1);
            const frameHeight = Math.max(targetHeight, 1);

            const widthRatio = frameWidth / image.width;
            const heightRatio = frameHeight / image.height;
            const scale = Math.min(widthRatio, heightRatio);
            const newWidth = image.width * scale;
            const newHeight = image.height * scale;

            // Sử dụng HTMLCanvasElement chuẩn trên Main Thread
            const canvas = document.createElement('canvas');
            canvas.width = frameWidth;
            canvas.height = frameHeight;
            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingQuality = 'high';

            // Phủ nền trắng đối với JPG, giữ nền trong suốt đối với PNG
            if (isJpg) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, frameWidth, frameHeight);
            } else {
                ctx.clearRect(0, 0, frameWidth, frameHeight);
            }

            const offsetX = (frameWidth - newWidth) / 2;
            const offsetY = (frameHeight - newHeight) / 2;
            ctx.drawImage(image, offsetX, offsetY, newWidth, newHeight);

            // Xuất ra Blob
            canvas.toBlob((blob) => {
                if (!blob) {
                    resolve({ dataUrl: originalDataUrl, size: imagesData[index]?.originalSize || 0, width: image.width, height: image.height });
                    return;
                }
                const reader = new FileReader();
                reader.onload = () => {
                    let finalDataUrl = reader.result;

                    // Lấy DPI người dùng chọn (mặc định 300 nếu không tìm thấy)
                    const targetPPI = imagesData[index]?.ppi || (typeof ppiSelect !== 'undefined' ? parseInt(ppiSelect.value) : 300);
                    
                    // CAN THIỆP HEADER: Ghi chỉ số DPI thật vào file DataUrl
                    finalDataUrl = injectDpiToDataUrl(finalDataUrl, targetPPI);

                    resolve({ 
                        dataUrl: finalDataUrl, 
                        size: blob.size, 
                        width: Math.round(newWidth), 
                        height: Math.round(newHeight) 
                    });
                };
                reader.readAsDataURL(blob);
            }, outputType);
        } catch (error) {
            console.error(`Error resizing image: ${error.message}`);
            resolve({ 
                dataUrl: originalDataUrl, 
                size: imagesData[index]?.originalSize || 0, 
                width: image?.width || 0, 
                height: image?.height || 0 
            });
        }
    });
}

function calculateEstimatedSize(originalSize, quality, fileType) {
    let compressionFactor;
    switch (fileType) {
        case 'image/jpeg': compressionFactor = 0.85; break;
        case 'image/png': compressionFactor = 0.65; break;
        case 'image/webp': compressionFactor = 0.9; break;
        default: compressionFactor = 0.8;
    }
    return Math.round(originalSize * (quality / 100) * compressionFactor);
}

function updateTableRow(index) {
    requestAnimationFrame(() => {
        const row = tableBody.children[index];
        if (!row) return;
        const { compressedDataUrl, compressedSize, originalSize, originalWidth, originalHeight, frameWidth, frameHeight, resizedDataUrl, isGIF, isWebP, fileType, isSupported } = imagesData[index];
        const quality = qualityInput.value / 100;
        const estimatedSize = calculateEstimatedSize(originalSize, qualityInput.value, fileType);

        if (!isSupported) {
            row.querySelector('.compressed-size').textContent = 'N/A';
            row.children[3].textContent = 'N/A';
        } else if (isGIF || (isWebP && compressedSize === originalSize)) {
            row.querySelector('.compressed-size').textContent = `${formatSize(originalSize)} (${languages[currentLanguage].table.unchanged})`;
            row.children[3].textContent = `${originalWidth}x${originalHeight}`;
        } else if (compressedDataUrl && compressedSize) {
            const reduction = ((originalSize - compressedSize) / originalSize) * 100;
            row.querySelector('.compressed-size').textContent = `${formatSize(compressedSize)} (${reduction >= 0 ? '-' : '+'}${Math.abs(reduction).toFixed(0)}%)`;
            row.children[3].textContent = frameWidth && frameHeight ? `${frameWidth}x${frameHeight}` : `${originalWidth}x${originalHeight}`;
        } else if (resizedDataUrl) {
            row.querySelector('.compressed-size').textContent = `${formatSize(originalSize)} ${languages[currentLanguage].table.notCompressedLabel}`;
            row.children[3].textContent = frameWidth && frameHeight ? `${frameWidth}x${frameHeight}` : `${originalWidth}x${originalHeight}`;
        } else {
            const reduction = ((originalSize - estimatedSize) / originalSize) * 100;
            row.querySelector('.compressed-size').textContent = `${formatSize(estimatedSize)} (${reduction >= 0 ? '-' : '+'}${Math.abs(reduction).toFixed(0)}%)`;
            row.children[3].textContent = languages[currentLanguage].table.notResized;
        }
    });
}

// 2. CHỨC NĂNG XEM TRƯỚC PREVIEW (Tự động căn giữa & điều chỉnh khung)
async function showPreview(index) {
    if (!imagesData[index]) return;
    currentIndex = index;
    const { originalImage, originalSize, compressedDataUrl, compressedSize, resizedDataUrl, isGIF, isWebP, isSupported } = imagesData[index];

    document.querySelectorAll('.table-row').forEach((row, i) => {
        row.classList.toggle('active', i === index);
    });

    preview.style.display = 'block';

    if (!isSupported || !originalImage) {
        previewOriginalImg.src = imagesData[index].originalDataUrl || '';
        previewCompressedImg.src = '';
        previewOriginalSize.textContent = formatSize(originalSize);
        previewCompressedSize.textContent = 'N/A';
        reductionPercent.textContent = '';
        return;
    }

    previewOriginalImg.src = originalImage.src;
    previewOriginalSize.textContent = formatSize(originalSize);

    // Tính toán chiều cao khung slider linh hoạt theo tỉ lệ ảnh
    const aspectRatio = originalImage.height / originalImage.width;
    const containerWidth = sliderContainer.offsetWidth || 600;
    const calculatedHeight = containerWidth * aspectRatio;
    
    // Giới hạn chiều cao khung trong khoảng từ 250px đến 450px để giao diện cân đối
    const finalHeight = Math.max(250, Math.min(calculatedHeight, 450));
    sliderContainer.style.height = `${finalHeight}px`;

    if (!compressedDataUrl && !resizedDataUrl && !isGIF && !(isWebP && await isAnimatedWebP(imagesData[index].file))) {
        const quality = qualityInput.value / 100;
        const targetWidth = imagesData[index].frameWidth;
        const targetHeight = imagesData[index].frameHeight;
        const result = await compressImage(originalImage, quality, imagesData[index].originalDataUrl, targetWidth, targetHeight, index);
        imagesData[index].compressedDataUrl = result.dataUrl;
        imagesData[index].compressedSize = result.size;
        updateTableRow(index);
    }

    if (resizedDataUrl && !compressedDataUrl) {
        previewCompressedImg.src = resizedDataUrl;
        previewCompressedSize.textContent = formatSize(originalSize);
        reductionPercent.textContent = languages[currentLanguage]?.preview?.notCompressed || '';
    } else if (compressedDataUrl) {
        previewCompressedImg.src = compressedDataUrl;
        if (isGIF || (isWebP && compressedSize === originalSize)) {
            previewCompressedSize.textContent = formatSize(originalSize);
            reductionPercent.textContent = languages[currentLanguage]?.preview?.unchanged || '';
        } else {
            updateCompressedSize(compressedSize, originalSize);
        }
    } else {
        previewCompressedImg.src = originalImage.src;
        const estimatedSize = calculateEstimatedSize(originalSize, qualityInput.value, imagesData[index].fileType);
        previewCompressedSize.textContent = formatSize(estimatedSize);
        const reduction = ((originalSize - estimatedSize) / originalSize) * 100;
        reductionPercent.textContent = `${reduction >= 0 ? '-' : '+'}${Math.abs(reduction).toFixed(0)}%`;
    }

    updateTotalCompressedSize();
    setupSlider();
}

function parseSizeInput(value) {
    if (!value) return null;
    const num = parseFloat(value);
    if (isNaN(num)) return null;
    return value.includes('.') ? Math.round(num * parseInt(ppiSelect.value)) : num;
}

async function updateResizeOnly() {
    const targetWidth = parseSizeInput(resizeWidth.value);
    const targetHeight = parseSizeInput(resizeHeight.value);

    if (targetWidth && targetHeight) {
        const promises = [];
        for (const [i, imgData] of imagesData.entries()) {
            if (imgData.isSupported && !imgData.isGIF && !(imgData.isWebP && await isAnimatedWebP(imgData.file))) {
                const { originalImage, originalDataUrl } = imgData;
                if (!originalImage) {
                    console.warn(`Original image is null at index ${i}, skipping resize`);
                    continue;
                }
                promises.push(resizeImage(originalImage, targetWidth, targetHeight, originalDataUrl, i).then(result => {
                    imgData.resizedDataUrl = result.dataUrl;
                    imgData.resizedWidth = result.width;
                    imgData.resizedHeight = result.height;
                    imgData.frameWidth = targetWidth;
                    imgData.frameHeight = targetHeight;

                    if (imgData.compressedDataUrl) {
                        const quality = qualityInput.value / 100;
                        return compressImage(originalImage, quality, result.dataUrl, targetWidth, targetHeight, i).then(compressedResult => {
                            imgData.compressedDataUrl = compressedResult.dataUrl;
                            imgData.compressedSize = compressedResult.size;
                        });
                    }
                }).then(() => {
                    updateTableRow(i);
                    if (i === currentIndex) {
                        previewCompressedImg.src = imgData.compressedDataUrl || imgData.resizedDataUrl;
                        previewCompressedSize.textContent = formatSize(imgData.compressedSize || imgData.originalSize);
                        reductionPercent.textContent = imgData.compressedSize
                            ? `${((imgData.originalSize - imgData.compressedSize) / imgData.originalSize * 100).toFixed(0)}%`
                            : languages[currentLanguage].preview.notCompressed;
                    }
                }));
            }
        }
        await Promise.all(promises);
    } else {
        const promises = [];
        for (const [i, imgData] of imagesData.entries()) {
            if (imgData.isSupported && !imgData.isGIF && !(imgData.isWebP && await isAnimatedWebP(imgData.file))) {
                imgData.resizedDataUrl = null;
                imgData.resizedWidth = null;
                imgData.resizedHeight = null;
                imgData.frameWidth = null;
                imgData.frameHeight = null;
                if (!imgData.compressedDataUrl) {
                    imgData.compressedSize = null;
                }
                promises.push(Promise.resolve().then(() => {
                    updateTableRow(i);
                    if (i === currentIndex) {
                        previewCompressedImg.src = imgData.compressedDataUrl || (imgData.originalImage ? imgData.originalImage.src : imgData.originalDataUrl);
                        const sizeToShow = imgData.compressedSize || calculateEstimatedSize(imgData.originalSize, qualityInput.value, imgData.fileType);
                        previewCompressedSize.textContent = formatSize(sizeToShow);
                        const reduction = ((imgData.originalSize - sizeToShow) / imgData.originalSize) * 100;
                        reductionPercent.textContent = `${reduction >= 0 ? '-' : '+'}${Math.abs(reduction).toFixed(0)}%`;
                    }
                }));
            }
        }
        await Promise.all(promises);
    }
    updateTotalCompressedSize();
}

async function updateAllCompressedPreviews() {
    const quality = qualityInput.value / 100;
    const promises = [];

    for (let i = 0; i < imagesData.length; i++) {
        const imgData = imagesData[i];
        if (imgData.isSupported && !imgData.isGIF && !(imgData.isWebP && await isAnimatedWebP(imgData.file))) {
            if (i !== currentIndex) {
                if (allCompressed || !imgData.compressedDataUrl) {
                    imgData.compressedDataUrl = null;
                    imgData.compressedSize = null;
                }
            } else if (!imgData.compressedDataUrl || allCompressed) {
                promises.push(compressImage(imgData.originalImage, quality, imgData.originalDataUrl, imgData.frameWidth, imgData.frameHeight, i).then(result => {
                    imgData.compressedDataUrl = result.dataUrl;
                    imgData.compressedSize = result.size;
                    previewCompressedImg.src = result.dataUrl;
                    updateCompressedSize(result.size, imgData.originalSize);
                    updateTableRow(i);
                }));
            } else {
                updateTableRow(i);
            }
        }
    }

    await Promise.all(promises);
    updateTotalCompressedSize();
}

function updateCompressedSize(compressedSize, originalSize) {
    previewCompressedSize.textContent = formatSize(compressedSize);
    const reduction = ((originalSize - compressedSize) / originalSize) * 100;
    reductionPercent.textContent = `${reduction >= 0 ? '-' : '+'}${Math.abs(reduction).toFixed(0)}%`;
}

function updateTotalOriginalSize() {
    requestAnimationFrame(() => {
        if (imagesData.length === 0) {
            sizeSummary.style.display = 'none';
            return;
        }
        let totalOriginal = 0;
        let totalImages = imagesData.length;
        let supportedCount = 0;
        imagesData.forEach(img => {
            totalOriginal += img.originalSize;
            if (img.isSupported) supportedCount++;
        });
        totalOriginalSize.innerHTML = `${languages[currentLanguage].totalOriginal}<span>${formatSize(totalOriginal)}</span> (${totalImages} ${languages[currentLanguage].summary.images}, ${supportedCount} supported)`;
        sizeSummary.style.display = 'block';
    });
}

function updateTotalCompressedSize() {
    requestAnimationFrame(() => {
        if (!imagesData.length) {
            if (totalCompressedFooter) totalCompressedFooter.innerHTML = '';
            return;
        }

        let totalOriginal = 0;
        let totalCompressed = 0;

        imagesData.forEach(img => {
            totalOriginal += img.originalSize;

            if (img.isSupported) {
                if (img.compressedSize !== null && img.compressedSize !== undefined) {
                    totalCompressed += img.compressedSize;
                } else if (img.resizedDataUrl) {
                    totalCompressed += img.originalSize;
                } else {
                    // Dự đoán dung lượng nếu chưa nhấn nén
                    totalCompressed += calculateEstimatedSize(img.originalSize, qualityInput.value, img.fileType);
                }
            } else {
                // File không hỗ trợ / GIF giữ nguyên dung lượng gốc
                totalCompressed += img.originalSize;
            }
        });

        // 1. Tính dung lượng chênh lệch (MB/KB)
        const savedSize = totalOriginal - totalCompressed;
        
        // 2. Tính tỉ lệ phần trăm
        const reduction = (savedSize / totalOriginal) * 100;
        const sign = reduction >= 0 ? '-' : '+';
        const formattedPercent = Math.abs(reduction).toFixed(0);

        // 3. Tạo chuỗi hiển thị số MB tiết kiệm/tăng thêm đa ngôn ngữ
const langSummary = languages[currentLanguage].summary;
let savedText = '';

if (savedSize > 0) {
    savedText = ` - ${langSummary.saved} <b>${formatSize(savedSize)}</b>`;
} else if (savedSize < 0) {
    savedText = ` - ${langSummary.increased} <b>${formatSize(Math.abs(savedSize))}</b>`;
}

        // 4. Render ra giao diện
        totalCompressedFooter.innerHTML = `
            ${languages[currentLanguage].totalCompressed}
            <span>${formatSize(totalCompressed)}</span> 
            <b>${sign}${formattedPercent}%</b>${savedText}
            (${imagesData.length} ${languages[currentLanguage].summary.images})
        `.trim();

        if (sizeSummary) sizeSummary.style.display = 'block';
    });
}

function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function setupSlider() {
    let isDragging = false;
    slider.style.left = '50%';
    previewCompressedImg.style.clipPath = 'inset(0 50% 0 0)';

    // Bật thuộc tính CSS này để chặn trình duyệt cuộn trang khi vuốt trên slider
    sliderContainer.style.touchAction = 'none';

    const getClientX = (e) => {
        if (e.touches && e.touches.length > 0) return e.touches[0].clientX;
        if (e.changedTouches && e.changedTouches.length > 0) return e.changedTouches[0].clientX;
        return e.clientX;
    };

    const updatePosition = (e) => {
        const rect = sliderContainer.getBoundingClientRect();
        const clientX = getClientX(e);
        if (clientX === undefined) return;

        let x = clientX - rect.left;
        x = Math.max(0, Math.min(x, rect.width));
        const percent = (x / rect.width) * 100;

        slider.style.left = `${percent}%`;
        previewCompressedImg.style.clipPath = `inset(0 ${100 - percent}% 0 0)`;
    };

    // Khi nhấn xuống (Chuột hoặc Cảm ứng)
    const onStart = (e) => {
        isDragging = true;
        updatePosition(e);
    };

    // Khi di chuyển (Chỉ cập nhật khi đang giữ dragging hoặc rê chuột TRONG container)
    const onMove = (e) => {
        if (isDragging) {
            updatePosition(e);
        }
    };

    // Di chuột xem thử (chỉ hoạt động bên trong sliderContainer)
    const onHover = (e) => {
        if (!isDragging) {
            updatePosition(e);
        }
    };

    // Khi nhả ra
    const onEnd = () => {
        isDragging = false;
    };

    // Sự kiện Chuột
    sliderContainer.addEventListener('mousedown', onStart);
    sliderContainer.addEventListener('mousemove', onHover);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);

    // Sự kiện Cảm ứng Mobile
    sliderContainer.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: true });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
}

function saveAllCompressedImages() {
    if (!imagesData.some(img => img.compressedDataUrl || img.resizedDataUrl)) {
        showNotification(languages[currentLanguage].notifications.notProcessed);
        return;
    }

    if (imagesData.length === 1) {
        const { compressedDataUrl, resizedDataUrl, file, fileType } = imagesData[0];
        const link = document.createElement('a');
        link.href = compressedDataUrl || resizedDataUrl;
        const ext = fileType === 'image/bmp' ? 'png' : fileType.split('/')[1] || 'jpg';
        link.download = `DIM_${file.name.replace(/\.[^.]+$/, '')}.${ext}`;
        link.click();
        showNotification(languages[currentLanguage].notifications.savedSingle);
        cleanUpMemory(0);
    } else {
        const zip = new JSZip();
        const folderName = `DIM_${getCurrentTimestamp()}`;
        const folder = zip.folder(folderName);

        imagesData.forEach(({ compressedDataUrl, resizedDataUrl, file, fileType }, index) => {
            if (compressedDataUrl || resizedDataUrl) {
                const base64Data = (compressedDataUrl || resizedDataUrl).split(',')[1];
                const ext = fileType === 'image/bmp' ? 'png' : fileType.split('/')[1] || 'jpg';
                folder.file(`DIM_${file.name.replace(/\.[^.]+$/, '')}.${ext}`, base64Data, { base64: true });
                cleanUpMemory(index);
            }
        });

        zip.generateAsync({ type: 'blob' }).then((content) => {
            saveAs(content, `${folderName}.zip`);
            showNotification(languages[currentLanguage].notifications.saved);
        });
    }
}

function getCurrentTimestamp() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    return `${year}${month}${day}${hours}${minutes}`;
}

function showNotification(message) {
    requestAnimationFrame(() => {
        notification.textContent = message;
        notification.style.display = 'block';
        notification.classList.add('show');
        setTimeout(() => {
            notification.classList.remove('show');
            notification.style.display = 'none';
        }, 3000);
    });
}

async function openRotatePopup() {
    if (currentIndex === -1 || !imagesData[currentIndex] || !imagesData[currentIndex].isSupported) {
        showNotification(languages[currentLanguage].notifications.error + 'No supported image selected.');
        return;
    }

    const item = imagesData[currentIndex];

    // Tự động khôi phục originalImage nếu nó bị trống nhưng vẫn còn originalDataUrl
    if (!item.originalImage && item.originalDataUrl) {
        try {
            item.originalImage = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = reject;
                im.src = item.originalDataUrl;
            });
        } catch (e) {
            showNotification((languages[currentLanguage]?.notifications?.error || '') + 'Failed to load image for rotation.');
            return;
        }
    }

    // Kiểm tra an toàn cuối cùng
    if (!item.originalImage) {
        showNotification((languages[currentLanguage]?.notifications?.error || '') + 'Image not available.');
        return;
    }

    currentRotation = 0;
    if (typeof customAngle !== 'undefined' && customAngle) {
        customAngle.value = '0';
    }
    
    rotatePopup.classList.add('show');
    drawRotateCanvas();
}

function closeRotatePopup() {
    rotatePopup.classList.remove('show');
}

// Khai báo biến trạng thái lật
let isFlippedH = false;
let isFlippedV = false;

// Hàm bật/tắt lật ngang
function toggleFlipH() {
    isFlippedH = !isFlippedH;
    drawRotateCanvas();
}

// Hàm bật/tắt lật dọc
function toggleFlipV() {
    isFlippedV = !isFlippedV;
    drawRotateCanvas();
}

function drawRotateCanvas() {
    const img = imagesData[currentIndex]?.originalImage;
    if (!img) {
        console.warn(`No valid image at index ${currentIndex} for rotation`);
        showNotification((languages[currentLanguage]?.notifications?.error || '') + 'Image not available for rotation.');
        closeRotatePopup();
        return;
    }

    const ctx = rotateCanvas.getContext('2d');
    const maxSize = 450; // Kích thước tối đa khung xem trước

    // Tính toán góc xoay Radian
    const rad = ((currentRotation % 360) * Math.PI) / 180;
    const absSin = Math.abs(Math.sin(rad));
    const absCos = Math.abs(Math.cos(rad));

    // Tính Bounding Box
    const boundingWidth = img.width * absCos + img.height * absSin;
    const boundingHeight = img.width * absSin + img.height * absCos;

    // Tỷ lệ co giãn vừa khung
    const scale = Math.min(maxSize / boundingWidth, maxSize / boundingHeight, 1);

    const canvasWidth = Math.round(boundingWidth * scale);
    const canvasHeight = Math.round(boundingHeight * scale);

    rotateCanvas.width = canvasWidth;
    rotateCanvas.height = canvasHeight;

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.save();

    // Dời gốc tọa độ về CHÍNH GIỮA Canvas
    ctx.translate(canvasWidth / 2, canvasHeight / 2);
    
    // Thực hiện xoay
    ctx.rotate(rad);

    // Thực hiện lật ảnh (Ngang / Dọc)
    ctx.scale(isFlippedH ? -1 : 1, isFlippedV ? -1 : 1);

    // Vẽ ảnh từ tâm
    const drawWidth = img.width * scale;
    const drawHeight = img.height * scale;
    ctx.drawImage(img, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);

    ctx.restore();
}

function rotateImage(angle) {
    currentRotation = (currentRotation + angle) % 360;
    if (currentRotation < 0) currentRotation += 360;
    if (customAngle) customAngle.value = currentRotation;
    drawRotateCanvas();
}

function previewRotate() {
    const angle = parseFloat(customAngle.value);
    if (isNaN(angle) || angle < -360 || angle > 360) {
        showNotification(languages[currentLanguage]?.notifications?.invalidAngle || 'Invalid angle');
        return;
    }
    currentRotation = angle;
    drawRotateCanvas();
}

function resetRotate() {
    currentRotation = 0;
    isFlippedH = false;
    isFlippedV = false;
    if (customAngle) customAngle.value = '0';
    drawRotateCanvas();
}

async function applyRotate() {
    if (currentIndex === -1 || !imagesData[currentIndex]) return;
    const item = imagesData[currentIndex];

    // Cơ chế thông minh: Nếu lỡ mất originalImage nhưng vẫn còn originalDataUrl, tự động khôi phục lại ngay lập tức
    if (!item.originalImage && item.originalDataUrl) {
        item.originalImage = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = item.originalDataUrl;
        });
    }

    const img = item.originalImage;
    if (!img) {
        showNotification((languages[currentLanguage]?.notifications?.error || '') + 'Image not available.');
        return;
    }

    // Nếu không xoay và không lật thì đóng popup luôn
    if (currentRotation === 0 && !isFlippedH && !isFlippedV) {
        closeRotatePopup();
        return;
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const angle = currentRotation;

    const rad = (angle * Math.PI) / 180;
    const sin = Math.abs(Math.sin(rad));
    const cos = Math.abs(Math.cos(rad));
    
    canvas.width = Math.round(img.width * cos + img.height * sin);
    canvas.height = Math.round(img.width * sin + img.height * cos);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.scale(isFlippedH ? -1 : 1, isFlippedV ? -1 : 1);
    ctx.drawImage(img, -img.width / 2, -img.height / 2);
    ctx.restore();

    const dataUrl = canvas.toDataURL('image/png');
    const newImg = new Image();
    await new Promise((resolve, reject) => {
        newImg.onload = resolve;
        newImg.onerror = reject;
        newImg.src = dataUrl;
    });

    cleanUpMemory(currentIndex);
    
    // Cập nhật mốc gốc mới để người dùng có thể xoay/cắt tiếp chồng lên nhau
    item.originalImage = newImg;
    item.originalDataUrl = dataUrl;
    item.originalWidth = canvas.width;
    item.originalHeight = canvas.height;
    
    // Reset các trạng thái render phụ
    item.compressedDataUrl = null;
    item.compressedSize = null;
    item.resizedDataUrl = null;
    item.resizedWidth = null;
    item.resizedHeight = null;
    item.frameWidth = null;
    item.frameHeight = null;

    // Reset cờ xoay/lật
    isFlippedH = false;
    isFlippedV = false;
    currentRotation = 0;

    updateTableRow(currentIndex);
    await showPreview(currentIndex);
    closeRotatePopup();
    
    showNotification(languages[currentLanguage]?.notifications?.rotated || 'Rotated successfully. You can continue editing.');
}

function openCropPopup() {
    if (currentIndex === -1 || !imagesData[currentIndex].isSupported) {
        showNotification(languages[currentLanguage].notifications.error + 'No supported image selected.');
        return;
    }
    cropPopup.classList.add('show');
    initCropCanvas();
}

function closeCropPopup() {
    cropPopup.classList.remove('show');
    cropOverlay.removeEventListener('mousedown', startCropDrag);
    document.removeEventListener('mousemove', moveCrop);
    document.removeEventListener('mouseup', stopCrop);
}

function initCropCanvas() {
    const img = imagesData[currentIndex].originalImage;
    const ctx = cropCanvas.getContext('2d');
    const maxSize = 500;
    const aspectRatio = img.width / img.height;
    let canvasWidth, canvasHeight;

    if (aspectRatio > 1) {
        canvasWidth = maxSize;
        canvasHeight = maxSize / aspectRatio;
    } else {
        canvasHeight = maxSize;
        canvasWidth = maxSize * aspectRatio;
    }

    cropCanvas.width = canvasWidth;
    cropCanvas.height = canvasHeight;
    ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);

    cropData = {
        x: canvasWidth * 0.25,
        y: canvasHeight * 0.25,
        width: canvasWidth * 0.5,
        height: canvasHeight * 0.5,
        isDragging: false,
        isResizing: false,
        handle: null
    };

    updateCropOverlay();
    
    // KÍCH HOẠT LẠI LẮNG NGHE SỰ KIỆN CẢM ỨNG VÀ CHUỘT
    setupCropEvents();
}

function updateCropOverlay() {
    if (!cropCanvas || cropCanvas.width === 0) return;

    const { x, y, width, height } = cropData;
    const img = imagesData[currentIndex]?.originalImage;

    // Lấy kích thước hiển thị thực tế trên màn hình (CSS Pixels)
    const rect = cropCanvas.getBoundingClientRect();
    const displayScaleX = rect.width / cropCanvas.width;
    const displayScaleY = rect.height / cropCanvas.height;

    // Định vị khung cắt chuẩn theo màn hình điện thoại/máy tính
    cropOverlay.style.left = `${x * displayScaleX}px`;
    cropOverlay.style.top = `${y * displayScaleY}px`;
    cropOverlay.style.width = `${width * displayScaleX}px`;
    cropOverlay.style.height = `${height * displayScaleY}px`;

    // Cập nhật thông số thước đo pixel thực tế của ảnh gốc
    if (img) {
        const scaleX = img.width / cropCanvas.width;
        const scaleY = img.height / cropCanvas.height;
        if (rulerHorizontal) rulerHorizontal.textContent = `${Math.round(width * scaleX)}px`;
        if (rulerVertical) rulerVertical.textContent = `${Math.round(height * scaleY)}px`;
    }
}

function setupCropEvents() {
    // Gỡ sự kiện cũ để không bao giờ bị lặp sự kiện
    cropOverlay.removeEventListener('pointerdown', startCropDrag);
    document.removeEventListener('pointermove', moveCrop);
    document.removeEventListener('pointerup', stopCrop);
    document.removeEventListener('pointercancel', stopCrop);

    // Dùng Pointer Events hỗ trợ đồng thời cả Cảm ứng Mobile & Chuột PC
    cropOverlay.addEventListener('pointerdown', startCropDrag);
    document.addEventListener('pointermove', moveCrop);
    document.addEventListener('pointerup', stopCrop);
    document.addEventListener('pointercancel', stopCrop);

    cropOverlay.querySelectorAll('.handle').forEach(handle => {
        handle.addEventListener('pointerdown', (e) => {
            cropData.isResizing = true;
            cropData.handle = handle.className.split(' ')[1];
            e.stopPropagation();

            // Khóa con trỏ/ngón tay vào phần tử kéo để không bị trượt ra ngoài
            if (e.target.setPointerCapture) {
                e.target.setPointerCapture(e.pointerId);
            }
        });
    });
}

function startCropDrag(e) {
    // Nếu chạm/click vào các nút kéo góc (handle), để sự kiện startCropResize xử lý
    if (e.target.classList.contains('handle')) return;

    cropData.isDragging = true;
    cropData.isResizing = false;

    // Trích xuất tọa độ Client chuẩn xác cho cả Touch và Mouse
    let clientX = e.clientX;
    let clientY = e.clientY;

    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    }

    cropData.startX = clientX;
    cropData.startY = clientY;
    cropData.originalX = cropData.x;
    cropData.originalY = cropData.y;

    // Giữ liên kết con trỏ nếu trình duyệt hỗ trợ Pointer Events
    if (e.pointerId && e.target.setPointerCapture) {
        try {
            e.target.setPointerCapture(e.pointerId);
        } catch (err) {
            // Bỏ qua nếu là sự kiện touch thuần túy
        }
    }
}
// 3. (Bổ sung thêm) Hàm bắt đầu kéo ĐỔI KÍCH THƯỚC ở 4 góc (Resize Handle)
function startCropResize(e, handleType) {
    e.stopPropagation(); // Ngăn sự kiện lan ra ngoài khung
    
    cropData.isResizing = true;
    cropData.isDragging = false;
    cropData.handle = handleType;

    let clientX = e.clientX;
    let clientY = e.clientY;

    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    }

    cropData.startX = clientX;
    cropData.startY = clientY;
    cropData.originalX = cropData.x;
    cropData.originalY = cropData.y;
    cropData.originalWidth = cropData.width;
    cropData.originalHeight = cropData.height;
}

function moveCrop(e) {
    if (!cropData.isDragging && !cropData.isResizing) return;

    // Ngăn điện thoại cuộn trang khi đang kéo khung cắt
    if (e.cancelable) e.preventDefault();

    const canvasRect = cropCanvas.getBoundingClientRect();

    // Tỉ lệ quy đổi từ màn hình thực tế về kích thước Canvas nội bộ
    const displayScaleX = cropCanvas.width / canvasRect.width;
    const displayScaleY = cropCanvas.height / canvasRect.height;

    // Lấy tọa độ Client (Touch hoặc Mouse)
    let clientX = e.clientX;
    let clientY = e.clientY;

    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    }

    // Tọa độ ngón tay/con chuột đã quy đổi về Canvas
    const mouseX = (clientX - canvasRect.left) * displayScaleX;
    const mouseY = (clientY - canvasRect.top) * displayScaleY;

    if (cropData.isDragging) {
        const dx = (clientX - cropData.startX) * displayScaleX;
        const dy = (clientY - cropData.startY) * displayScaleY;

        cropData.x = Math.max(0, Math.min(cropData.originalX + dx, cropCanvas.width - cropData.width));
        cropData.y = Math.max(0, Math.min(cropData.originalY + dy, cropCanvas.height - cropData.height));
    } else if (cropData.isResizing) {
        const minSize = 20; // Kích thước khung cắt tối thiểu (px)
        const currentRight = cropData.x + cropData.width;
        const currentBottom = cropData.y + cropData.height;
        const currentLeft = cropData.x;
        const currentTop = cropData.y;

        let newLeft = cropData.x;
        let newTop = cropData.y;
        let newWidth = cropData.width;
        let newHeight = cropData.height;

        switch (cropData.handle) {
            case 'top-left':
                newLeft = Math.max(0, Math.min(currentRight - minSize, mouseX));
                newTop = Math.max(0, Math.min(currentBottom - minSize, mouseY));
                newWidth = currentRight - newLeft;
                newHeight = currentBottom - newTop;
                break;

            case 'top-right':
                const newRightTR = Math.max(currentLeft + minSize, Math.min(cropCanvas.width, mouseX));
                newTop = Math.max(0, Math.min(currentBottom - minSize, mouseY));
                newLeft = currentLeft;
                newWidth = newRightTR - currentLeft;
                newHeight = currentBottom - newTop;
                break;

            case 'bottom-left':
                newLeft = Math.max(0, Math.min(currentRight - minSize, mouseX));
                const newBottomBL = Math.max(currentTop + minSize, Math.min(cropCanvas.height, mouseY));
                newTop = currentTop;
                newWidth = currentRight - newLeft;
                newHeight = newBottomBL - currentTop;
                break;

            case 'bottom-right':
                const newRightBR = Math.max(currentLeft + minSize, Math.min(cropCanvas.width, mouseX));
                const newBottomBR = Math.max(currentTop + minSize, Math.min(cropCanvas.height, mouseY));
                newLeft = currentLeft;
                newTop = currentTop;
                newWidth = newRightBR - currentLeft;
                newHeight = newBottomBR - currentTop;
                break;
        }

        cropData.x = newLeft;
        cropData.y = newTop;
        cropData.width = newWidth;
        cropData.height = newHeight;
    }

    updateCropOverlay();
}

function stopCrop() {
    cropData.isDragging = false;
    cropData.isResizing = false;
    cropData.handle = null;
}

function resetCrop() {
    initCropCanvas();
}

async function applyCrop() {
    if (currentIndex === -1 || !imagesData[currentIndex]) return;
    const item = imagesData[currentIndex];
    const { x, y, width, height } = cropData;
    
    if (width <= 0 || height <= 0) {
        showNotification(languages[currentLanguage]?.notifications?.invalidCrop || 'Invalid crop area.');
        return;
    }

    if (!item.originalImage && item.originalDataUrl) {
        item.originalImage = await new Promise((resolve, reject) => {
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = reject;
            im.src = item.originalDataUrl;
        });
    }

    const img = item.originalImage;
    if (!img) {
        showNotification((languages[currentLanguage]?.notifications?.error || '') + 'Image not available.');
        return;
    }

    const scaleX = img.width / cropCanvas.width;
    const scaleY = img.height / cropCanvas.height;
    const cropX = x * scaleX;
    const cropY = y * scaleY;
    const cropWidth = width * scaleX;
    const cropHeight = height * scaleY;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    ctx.drawImage(img, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const dataUrl = canvas.toDataURL('image/png');
    const newImg = new Image();
    await new Promise((resolve, reject) => {
        newImg.onload = resolve;
        newImg.onerror = reject;
        newImg.src = dataUrl;
    });

    cleanUpMemory(currentIndex);
    
    // Cập nhật mốc gốc mới sau khi cắt
    item.originalImage = newImg;
    item.originalDataUrl = dataUrl;
    item.originalWidth = canvas.width;
    item.originalHeight = canvas.height;
    
    item.compressedDataUrl = null;
    item.compressedSize = null;
    item.resizedDataUrl = null;
    item.resizedWidth = null;
    item.resizedHeight = null;
    item.frameWidth = null;
    item.frameHeight = null;

    updateTableRow(currentIndex);
    await showPreview(currentIndex);
    closeCropPopup();
    
    showNotification(languages[currentLanguage]?.notifications?.cropped || 'Cropped successfully. You can continue editing.');
}

function resetImage() {
    if (currentIndex === -1) return;
    const original = originalImagesData[currentIndex];
    if (!original) return;

    cleanUpMemory(currentIndex);
    imagesData[currentIndex] = { ...original };
    const newImg = new Image();
    newImg.onload = () => {
        imagesData[currentIndex].originalImage = newImg;
        updateTableRow(currentIndex);
        showPreview(currentIndex);
        showNotification(languages[currentLanguage].notifications.resetImage);
        if (rotatePopup.classList.contains('show')) {
            drawRotateCanvas();
        } else if (cropPopup.classList.contains('show')) {
            initCropCanvas();
        }
    };
    newImg.src = original.originalDataUrl;
}

function resetAllImages() {
    if (imagesData.length === 0) return;
    imagesData.forEach((_, index) => {
        cleanUpMemory(index);
        imagesData[index] = { ...originalImagesData[index] };
        const newImg = new Image();
        newImg.onload = () => {
            imagesData[index].originalImage = newImg;
            updateTableRow(index);
            if (index === currentIndex) {
                showPreview(currentIndex);
            }
        };
        newImg.src = imagesData[index].originalDataUrl;
    });
    showNotification(languages[currentLanguage].notifications.resetAll);
}

document.addEventListener('DOMContentLoaded', () => {
    // ===== Lưu & khôi phục ngôn ngữ =====
    const savedLang = localStorage.getItem('preferredLanguage') || 'en';
    currentLanguage = savedLang;

    const langSelect = document.getElementById('langSelect');
    if (langSelect) {
        langSelect.value = savedLang;
    }

    switchLanguage(savedLang);

    qualityValue.textContent = `${qualityInput.value}%`;

    const editButtons = document.querySelector('.edit-buttons');
    if (editButtons) {
        const resetAllBtn = document.createElement('button');
        resetAllBtn.setAttribute('data-lang', 'resetAllBtn');
        resetAllBtn.textContent = languages[currentLanguage].resetAllBtn;
        resetAllBtn.onclick = resetAllImages;
        editButtons.appendChild(resetAllBtn);
    }

    // Gắn sự kiện cho các nút điều khiển
    const rotateBtn = document.querySelector('[data-lang="rotateBtn"]');
    const cropBtn = document.querySelector('[data-lang="cropBtn"]');
    const previewBtn = document.querySelector('[data-lang="previewBtn"]');
    const ResetBtn = document.querySelector('[data-lang="ResetBtn"]');
    const applyBtn = document.querySelector('[data-lang="applyBtn"]');
    const resetImageBtn = document.querySelector('[data-lang="resetImageBtn"]');
    const closeRotateBtn = document.querySelector('#rotatePopup .close-btn');
    const closeCropBtn = document.querySelector('#cropPopup .close-btn');
    const rotate90 = document.querySelector('#rotate90');
    const rotate180 = document.querySelector('#rotate180');
    const rotate270 = document.querySelector('#rotate270');
    const resetRotateBtn = document.querySelector('#resetRotate');
    const applyCropBtn = document.querySelector('#applyCrop');
    const resetCropBtn = document.querySelector('#resetCrop');
    const compressAllBtn = document.querySelector('[data-lang="compressAllBtn"]');
    const saveAllBtn = document.querySelector('.save-all-btn');

    // Gắn sự kiện cho các nút
    if (rotateBtn) rotateBtn.onclick = openRotatePopup;
    if (cropBtn) cropBtn.onclick = openCropPopup;
    if (previewBtn) previewBtn.onclick = previewRotate;
    if (ResetBtn) ResetBtn.onclick = resetRotate;
    if (applyBtn) applyBtn.onclick = applyRotate;
    if (resetImageBtn) resetImageBtn.onclick = resetImage;
    if (closeRotateBtn) closeRotateBtn.onclick = closeRotatePopup;
    if (closeCropBtn) closeCropBtn.onclick = closeCropPopup;
    if (rotate90) rotate90.onclick = () => rotateImage(90);
    if (rotate180) rotate180.onclick = () => rotateImage(180);
    if (rotate270) rotate270.onclick = () => rotateImage(270);
    if (resetRotateBtn) resetRotateBtn.onclick = resetRotate;
    if (applyCropBtn) applyCropBtn.onclick = applyCrop;
    if (resetCropBtn) resetCropBtn.onclick = resetCrop;
    if (compressAllBtn) compressAllBtn.onclick = compressAllImages;
    if (saveAllBtn) saveAllBtn.onclick = saveAllCompressedImages;

    if (langSelect) {
        langSelect.onchange = (e) => switchLanguage(e.target.value);
        langSelect.style.backgroundImage = `url('${langSelect.options[langSelect.selectedIndex].getAttribute('data-flag')}')`;
    }

    // Đăng ký sự kiện Crop một lần duy nhất tại đây
    if (typeof setupCropEvents === 'function') {
        setupCropEvents();
    }

    // Khởi tạo giao diện ban đầu
    imageTable.style.display = 'none';
    previewSection.style.display = 'none';
    controls.style.display = 'none';
    sizeSummary.style.display = 'none';
    loadingOverlay.style.display = 'none';
});

// Xử lý sự kiện trước khi thoát trang để dọn dẹp tài nguyên
window.addEventListener('beforeunload', () => {
    if (workerPool) {
        workerPool.terminate();
    }
    imagesData.forEach((_, index) => cleanUpMemory(index));
});

// Hàm tiện ích để chuyển đổi từ inch sang pixel dựa trên PPI
function convertInchToPx(value, ppi) {
    return Math.round(parseFloat(value) * ppi);
}

// Hàm cập nhật kích thước ảnh dựa trên PPI
// CHỨC NĂNG CẬP NHẬT PPI (Đã hợp nhất & sửa lỗi)
function updatePPI() {
    const ppi = parseInt(ppiSelect.value);
    if (isNaN(ppi) || ppi <= 0) return;

    // 1. Cập nhật giá trị PPI và recalculate khung hình cho toàn bộ mảng dữ liệu
    imagesData.forEach((imgData, index) => {
        if (imgData.isSupported) {
            imgData.ppi = ppi; // Lưu lại PPI mới cho từng ảnh

            if (inputUnit.width === 'inch' && resizeWidth.value) {
                const inches = parseFloat(resizeWidth.value);
                if (!isNaN(inches)) {
                    imgData.frameWidth = Math.round(inches * ppi);
                }
            }
            if (inputUnit.height === 'inch' && resizeHeight.value) {
                const inches = parseFloat(resizeHeight.value);
                if (!isNaN(inches)) {
                    imgData.frameHeight = Math.round(inches * ppi);
                }
            }
            updateTableRow(index);
        }
    });

    // 2. Cập nhật lại ảnh đang xem trước (Preview)
    if (currentIndex !== -1 && imagesData[currentIndex]?.isSupported) {
        updateResizeOnly();
        showPreview(currentIndex);
    }
}

// Hàm tối ưu hóa giao diện khi cuộn bảng
tableBody.addEventListener('scroll', throttle(() => {
    const rows = tableBody.children;
    for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect();
        if (rect.top >= 0 && rect.bottom <= window.innerHeight) {
            updateTableRow(i);
        }
    }
}, 100));

// Hàm xử lý lỗi bất ngờ
window.addEventListener('error', (event) => {
    console.error('Global error:', event.message);
    showNotification(languages[currentLanguage].notifications.error + event.message);
});

// Hàm đảm bảo canvas không bị vỡ ảnh trên màn hình retina
function setupHighDpiCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    return ctx;
}

// 1. Hàm xử lý khi thay đổi kích thước cửa sổ (Resize / Xoay màn hình)
window.addEventListener('resize', debounce(() => {
    if (currentIndex !== -1) {
        showPreview(currentIndex);
    }
    if (rotatePopup && rotatePopup.classList.contains('show')) {
        drawRotateCanvas();
    }
    if (cropPopup && cropPopup.classList.contains('show')) {
        // KHÔNG gọi initCropCanvas() vì sẽ reset mất khung cắt của người dùng!
        // Chỉ cập nhật lại vị trí hiển thị (Overlay) cho chuẩn tỉ lệ mới:
        updateCropOverlay(); 
    }
}, 200));

// Hàm kiểm tra và cập nhật trạng thái nút Save All
function updateSaveAllButtonState() {
    const saveAllBtn = document.querySelector('.save-all-btn');
    if (saveAllBtn) {
        saveAllBtn.disabled = !imagesData.some(img => img.compressedDataUrl || img.resizedDataUrl);
    }
}

// Hàm xử lý tải ảnh từ URL (nếu cần mở rộng)
async function loadImageFromUrl(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        const file = new File([blob], 'image.jpg', { type: blob.type });
        const validation = await isValidImageFile(file);
        if (!validation.valid) {
            showNotification(languages[currentLanguage].notifications.invalidFile + url);
            return;
        }

        // Dùng DataTransfer để gán file vào HTMLInputElement hợp lệ
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        imageInput.files = dataTransfer.files;

        loadImages();
    } catch (error) {
        showNotification(languages[currentLanguage].notifications.error + error.message);
    }
}

// Hàm xử lý phím tắt cho UX tốt hơn
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'Escape') {
        if (rotatePopup.classList.contains('show')) closeRotatePopup();
        if (cropPopup.classList.contains('show')) closeCropPopup();
    }
    if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        saveAllCompressedImages();
    }
    if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        resetAllImages();
    }
});

// Hàm khởi tạo lại Worker Pool nếu cần
function reinitializeWorkerPool() {
    if (workerPool) {
        workerPool.terminate();
    }
    try {
        workerPool = new WorkerPool(navigator.hardwareConcurrency || 4);
    } catch (error) {
        console.error('Failed to reinitialize Worker Pool:', error);
        showNotification(languages[currentLanguage].notifications.error + 'Worker Pool reinitialization failed.');
    }
}

// Hàm chèn thông số DPI trực tiếp vào Header của file JPEG/JPG
function injectDpiToDataUrl(dataUrl, ppi) {
    if (!dataUrl || !dataUrl.startsWith('data:image/')) return dataUrl;

    const mimeType = dataUrl.split(';')[0].split(':')[1];
    if (mimeType !== 'image/jpeg' && mimeType !== 'image/jpg') {
        return dataUrl; // Áp dụng chuẩn nhất cho file JPEG/JPG
    }

    const base64 = dataUrl.split(',')[1];
    const binaryStr = atob(base64);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
    }

    // Tìm thẻ JFIF App0 Marker (FF E0) để ghi đè chỉ số DPI
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        let offset = 2;
        while (offset < bytes.length - 1) {
            if (bytes[offset] === 0xFF && bytes[offset + 1] === 0xE0) {
                bytes[offset + 11] = 1;                 // Units: 1 = Dots Per Inch (DPI)
                bytes[offset + 12] = (ppi >> 8) & 0xFF; // X resolution (High Byte)
                bytes[offset + 13] = ppi & 0xFF;        // X resolution (Low Byte)
                bytes[offset + 14] = (ppi >> 8) & 0xFF; // Y resolution (High Byte)
                bytes[offset + 15] = ppi & 0xFF;        // Y resolution (Low Byte)
                break;
            }
            offset++;
        }
    }

    let newBinaryStr = '';
    for (let i = 0; i < bytes.length; i++) {
        newBinaryStr += String.fromCharCode(bytes[i]);
    }
    return `data:${mimeType};base64,${btoa(newBinaryStr)}`;
}