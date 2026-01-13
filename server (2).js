console.log('🔥 Kaizen – Multi-file Safe Silence Processor');

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

/* ===============================
   BASE DIRECTORIES
================================ */
['uploads', 'jobs'].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

/* ===============================
   MULTER (DISK STORAGE, MULTI FILE)
================================ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) =>
    cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
}).array('media', 10);

/* ===============================
   UI
================================ */
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/jobs', express.static(path.join(__dirname, 'jobs')));

/* ===============================
   MULTI FILE PROCESS
================================ */
app.post('/process', (req, res) => {
  upload(req, res, async err => {
    if (err) return res.status(400).send(err.message);
    if (!req.files || req.files.length === 0)
      return res.status(400).send('No files uploaded');

    console.log(`FILES RECEIVED: ${req.files.length}`);

    const jobId = `job-${Date.now()}`;
    const jobDir = path.join('jobs', jobId);
    const inputDir = path.join(jobDir, 'input');
    const outputDir = path.join(jobDir, 'output');

    fs.mkdirSync(jobDir);
    fs.mkdirSync(inputDir);
    fs.mkdirSync(outputDir);

    // Move uploads into job folder
    for (const file of req.files) {
      fs.renameSync(
        file.path,
        path.join(inputDir, file.originalname)
      );
    }

    const results = [];

    // 🔒 Process sequentially
    for (const filename of fs.readdirSync(inputDir)) {
      const inputPath = path.join(inputDir, filename);

      const inputExt = path.extname(filename).toLowerCase();
      const base = path.basename(filename, inputExt);

      // ✅ FIXED OUTPUT CONTAINER LOGIC
      let outputExt = '.mp4';
      if (['.mp3', '.wav', '.aac', '.m4a', '.ogg'].includes(inputExt)) {
        outputExt = '.m4a';
      }

      const outputName = `${base} finished${outputExt}`;
      const outputPath = path.join(outputDir, outputName);

      await processSingleFile(inputPath, outputPath);

      results.push({
        name: outputName,
        download: `/jobs/${jobId}/output/${outputName}`
      });

      // delete input immediately
      fs.unlinkSync(inputPath);
    }

    // auto-delete job after 24h
    setTimeout(() => {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }, 24 * 60 * 60 * 1000);

    res.json({ files: results });
  });
});

/* ===============================
   START SERVER
================================ */
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

/* =====================================================
   CORE PROCESSING
===================================================== */

function processSingleFile(input, output) {
  return new Promise(async resolve => {
    const silences = await detectSilence(input);
    const duration = await getDuration(input);

    // ⚠️ If no long silences → fast re-encode only
    if (silences.length === 0) {
      const ff = spawn('ffmpeg', [
        '-y',
        '-i', input,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        output
      ]);
      ff.on('close', resolve);
      return;
    }

    const keepSegments = buildKeepSegments({
      silences,
      totalDuration: duration
    });

    const filter = buildConcatFilter(keepSegments);

    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-i', input,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      output
    ]);

    ffmpeg.on('close', resolve);
  });
}

/* ===============================
   HELPERS
================================ */

function detectSilence(file) {
  return new Promise(resolve => {
    const ff = spawn('ffmpeg', [
      '-i', file,
      '-vn',
      '-af', 'silencedetect=noise=-30dB:d=1.0',
      '-f', 'null',
      '-'
    ]);

    let log = '';
    ff.stderr.on('data', d => {
      const t = d.toString();
      if (t.includes('silence_')) log += t;
    });

    ff.on('close', () => {
      const silences = [];
      let current = null;

      log.split('\n').forEach(line => {
        if (line.includes('silence_start')) {
          current = { start: parseFloat(line.split('silence_start:')[1]) };
        }
        if (line.includes('silence_end') && current) {
          const end = parseFloat(line.split('silence_end:')[1]);
          silences.push({ start: current.start, end });
          current = null;
        }
      });

      if (current) silences.push({ start: current.start, end: null });
      resolve(silences);
    });
  });
}

function getDuration(file) {
  return new Promise(resolve => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file
    ]);
    let out = '';
    ff.stdout.on('data', d => out += d.toString());
    ff.on('close', () => resolve(parseFloat(out)));
  });
}

/* ===============================
   STEP 5 – SEGMENT MATH (SAFE)
================================ */

function buildKeepSegments({
  silences,
  totalDuration,
  postSpeechBuffer = 0.5,
  preSpeechBuffer = 0.5,
  minKeep = 0.2
}) {
  const keep = [];
  let cursor = 0;

  for (const s of silences) {
    const end = s.end ?? totalDuration;
    const cutStart = s.start + postSpeechBuffer;
    const cutEnd = end - preSpeechBuffer;

    if (cutStart - cursor >= minKeep) {
      keep.push({ start: cursor, end: cutStart });
    }
    cursor = Math.max(cursor, cutEnd);
  }

  if (totalDuration - cursor >= minKeep) {
    keep.push({ start: cursor, end: totalDuration });
  }

  return keep;
}

/* ===============================
   FILTER (SYNC SAFE)
================================ */

function buildConcatFilter(segments) {
  let v = '';
  let a = '';

  segments.forEach((s, i) => {
    v += `[0:v]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[v${i}];`;
    a += `[0:a]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[a${i}];`;
  });

  const vOut = segments.map((_, i) => `[v${i}]`).join('');
  const aOut = segments.map((_, i) => `[a${i}]`).join('');

  return `${v}${a}${vOut}concat=n=${segments.length}:v=1:a=0[v];${aOut}concat=n=${segments.length}:v=0:a=1[a]`;
}
