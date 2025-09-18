const canvas = document.getElementById('spec');
const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: false });

const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const fftSel   = document.getElementById('fft');
const scaleSel = document.getElementById('scale');
const infoEl   = document.getElementById('info');

let ac, analyser, src, stream, rafId = null;
let bins, columnImageData;
let rowToBin = null; // y -> bin index
const COLUMN_WIDTH = 1; // px per frame

// Параметры "теней"
const params = {
    blackDb: -100, // всё тише -100 dB считаем чёрным
    gamma: 1.2,   // >1 делает тени темнее; 1.2..2.0 — норм
    cutoff: 0.0   // мягкий порог (0..0.15). Если >0 — ещё чёрнее низы
};

function dbTo01(db) {
    const max = analyser ? analyser.maxDecibels : -30;  // опираемся на анализатор
    const bp  = params.blackDb;

    // всё ниже bp → 0
    let t = (db - bp) / (max - bp);
    t = Math.max(0, Math.min(1, t));

    // затемнение очень тихих
    if (t < params.cutoff) t = 0;

    // низы к чёрному
    t = Math.pow(t, params.gamma);

    return t;
}


// от тёмно-синего к бирюзовому и к жёлтому
const stops = [
    {t:0.0, c:[ 12,  7,134]},
    {t:0.5, c:[  0,255,255]},
    {t:1.0, c:[255,255,  0]},
];

function lerp(a,b,x){ return a + (b-a)*x; }
function lerp3(c1,c2,x){ return [(lerp(c1[0],c2[0],x))|0,(lerp(c1[1],c2[1],x))|0,(lerp(c1[2],c2[2],x))|0]; }

function simpleMap(t){
    if (t<=0) return stops[0].c;
    if (t>=1) return stops[stops.length-1].c;
    for (let i=0;i<stops.length-1;i++){
        const a=stops[i], b=stops[i+1];
        if (t>=a.t && t<=b.t){
            const x = (t - a.t) / (b.t - a.t);
            return lerp3(a.c, b.c, x);
        }
    }
}

// таблица соответствия
const LUT = new Array(256).fill(0).map((_,i)=> {
    const t = i/255;
    return simpleMap(t);
});

// polynomial approximation
// function turbo(t) {
//
//     const r = Math.min(1, Math.max(0,  0.13572138 + 4.61539260*t - 42.66032258*t*t + 132.13108234*t*t*t - 152.94239396*t*t*t*t + 59.28637943*t*t*t*t*t ));
//     const g = Math.min(1, Math.max(0,  0.09140261 + 2.19418839*t + 4.84296658*t*t - 14.18503333*t*t*t + 14.31328095*t*t*t*t - 5.23388067*t*t*t*t*t ));
//     const b = Math.min(1, Math.max(0,  0.10667330 + 13.01756486*t - 76.43603761*t*t + 207.57020713*t*t*t - 241.07774782*t*t*t*t + 100.93034855*t*t*t*t*t));
//     return [ (r*255)|0, (g*255)|0, (b*255)|0 ];
// }

function buildRowToBinMap(height, binCount, type='log') {
    const map = new Uint16Array(height);
    if (type === 'linear') {
        for (let y=0; y<height; y++) {
            const frac = (height - 1 - y) / (height - 1);
            map[y] = Math.min(binCount - 1, Math.max(0, Math.round(frac * (binCount - 1))));
        }
    } else {
        // logarithmic
        const minBin = 1;
        const maxBin = binCount-1;
        const logMin = Math.log(minBin + 1);
        const logMax = Math.log(maxBin + 1);
        for (let y=0; y<height; y++) {
            const frac = (height - 1 - y) / (height - 1);
            const val = Math.exp(logMin + frac * (logMax - logMin)) - 1;
            map[y] = Math.min(maxBin, Math.max(minBin, Math.round(val)));
        }
    }
    return map;
}

function setupAnalyser(fftSize) {
    analyser.fftSize = fftSize;
    analyser.smoothingTimeConstant = 0.0; // чистые срезы
    analyser.minDecibels = -100;
    analyser.maxDecibels = -30;
    bins = new Float32Array(analyser.frequencyBinCount);
    columnImageData = ctx.createImageData(COLUMN_WIDTH, canvas.height);
    rowToBin = buildRowToBinMap(canvas.height, analyser.frequencyBinCount, scaleSel.value);
}

function drawColumn() {
    analyser.getFloatFrequencyData(bins);

    // scroll left
    ctx.drawImage(canvas, COLUMN_WIDTH, 0, canvas.width - COLUMN_WIDTH, canvas.height, 0, 0, canvas.width - COLUMN_WIDTH, canvas.height);

    for (let y = 0; y < canvas.height; y++) {
        const binIdx = rowToBin[y];

        const v = dbTo01(bins[binIdx]); // 0..1

        let r, g, b;
        if (v === 0) {
            r = g = b = 0;       // чистый чёрный
        } else {
            [r, g, b] = LUT[Math.max(0, Math.min(255, (v*255)|0))];
        }

        const i = (y * COLUMN_WIDTH) * 4;
        columnImageData.data[i+0] = r;
        columnImageData.data[i+1] = g;
        columnImageData.data[i+2] = b;
        columnImageData.data[i+3] = 255;
    }
    ctx.putImageData(columnImageData, canvas.width - COLUMN_WIDTH, 0);
}

function loop() {
    drawColumn();
    rafId = requestAnimationFrame(loop);
}

async function start() {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    fftSel.disabled = true;
    scaleSel.disabled = true;

    stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
        }
    });
    ac = new (window.AudioContext || window.webkitAudioContext)();
    analyser = ac.createAnalyser();
    src = ac.createMediaStreamSource(stream);
    src.connect(analyser);

    setupAnalyser(parseInt(fftSel.value, 10));
    infoEl.textContent = `${ac.sampleRate} Hz • bins ${analyser.frequencyBinCount} • scale ${scaleSel.value}`;
    loop();
}

function stop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    try {
        if (src) src.disconnect();
        if (analyser) analyser.disconnect?.();
        if (ac) ac.close();
        if (stream) stream.getTracks().forEach(t => t.stop());
    } catch {}
    startBtn.disabled = false;
    stopBtn.disabled = true;
    fftSel.disabled = false;
    scaleSel.disabled = false;
    infoEl.textContent = '—';
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
fftSel.addEventListener('change', () => {
    if (!analyser) return;
    setupAnalyser(parseInt(fftSel.value, 10));
});
scaleSel.addEventListener('change', () => {
    if (!analyser) return;
    rowToBin = buildRowToBinMap(canvas.height, analyser.frequencyBinCount, scaleSel.value);
    infoEl.textContent = `sampleRate ${ac.sampleRate} Hz • bins ${analyser.frequencyBinCount} • scale ${scaleSel.value}`;
});


const resize = async () => {
    const dpr  = Math.max(1, window.devicePixelRatio || 1);
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    const oldW = canvas.width;
    const oldH = canvas.height;

    // Snapshot
    let snapshot = null;
    if (oldW && oldH) {
        try {
            snapshot = await createImageBitmap(canvas); // быстрый бэкап
        } catch {
            // Фоллбек для старых браузеров
            const tmp = document.createElement('canvas');
            tmp.width = oldW; tmp.height = oldH;
            tmp.getContext('2d').drawImage(canvas, 0, 0);
            snapshot = tmp;
        }
    }

    // DPR
    canvas.width  = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width  = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.imageSmoothingEnabled = false;

    // Restore
    if (snapshot) {

        const newW = canvas.width, newH = canvas.height;

        const dx = newW - oldW;

        if (dx >= 0) {
            ctx.drawImage(snapshot, 0, 0, oldW, oldH, dx, 0, oldW, newH);
        } else {
            const sx = -dx;           // сколько пикселей отрезать слева у источника
            const srcW = oldW - sx;   // оставшаяся ширина
            const dstW = Math.min(srcW, newW);
            ctx.drawImage(snapshot, sx, 0, srcW, oldH, 0, 0, dstW, newH);
        }
    }

    // Пересобираем под новую высоту
    if (analyser) {
        columnImageData = ctx.createImageData(COLUMN_WIDTH, canvas.height);
        rowToBin = buildRowToBinMap(canvas.height, analyser.frequencyBinCount, scaleSel.value);
    }
};

window.addEventListener('resize', () => { resize(); });
resize();