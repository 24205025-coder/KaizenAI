const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = 3000;

/* ================= SERVE UI ================= */
app.use(express.static("public"));

/* ================= CONFIG ================= */
const BASE_DIR = path.join(__dirname, "jobs");
const MAX_FILES = 10;
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
const MAX_CONCURRENT_JOBS = 2;
const JOB_TTL = 24 * 60 * 60 * 1000;

/* ================= JUMPCUT SAFE MODE ================= */
const SILENCE_DB = "-35dB";
const MIN_SILENCE = 0.6;
const KEEP_BEFORE = 0.3;
const KEEP_AFTER = 0.3;
const FADE = 0.08;

/* ================= STATE ================= */
const jobs = new Map();
const queue = [];
let activeJobs = 0;

/* ================= UTILS ================= */
function uid() {
  return crypto.randomUUID();
}
function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function safeDelete(p) {
  try { fs.unlinkSync(p); } catch {}
}

/* ================= FFMPEG HELPERS ================= */
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let log = "";
    p.stderr.on("data", d => (log += d.toString()));
    p.on("close", c => (c === 0 ? resolve(log) : reject(log)));
  });
}

async function getDuration(file) {
  try {
    await runFFmpeg(["-i", file]);
  } catch (e) {
    const m = e.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
    if (!m) throw new Error("Duration parse failed");
    return (+m[1] * 3600) + (+m[2] * 60) + (+m[3]);
  }
}

async function detectSilences(file) {
  const log = await runFFmpeg([
    "-i", file,
    "-af", `silencedetect=noise=${SILENCE_DB}:d=${MIN_SILENCE}`,
    "-f", "null", "-"
  ]);

  const silences = [];
  let start = null;

  log.split("\n").forEach(line => {
    if (line.includes("silence_start")) {
      start = parseFloat(line.split("silence_start:")[1]);
    }
    if (line.includes("silence_end") && start !== null) {
      const end = parseFloat(line.split("silence_end:")[1]);
      if (end - start >= MIN_SILENCE) silences.push({ start, end });
      start = null;
    }
  });

  return silences;
}

function buildKeepSegments(silences, duration) {
  let cursor = 0;
  const keeps = [];

  for (const s of silences) {
    const keepEnd = s.start + KEEP_BEFORE;
    const nextStart = s.end - KEEP_AFTER;

    if (keepEnd > cursor) {
      keeps.push({ start: cursor, end: keepEnd });
      cursor = nextStart;
    }
  }

  if (cursor < duration) keeps.push({ start: cursor, end: duration });
  return keeps;
}

function buildFilterGraph(segs) {
  let f = [];
  let c = [];

  segs.forEach((s, i) => {
    const dur = s.end - s.start;
    const fadeOut = Math.max(0, dur - FADE);

    f.push(
      `[0:v]trim=${s.start}:${s.end},setpts=PTS-STARTPTS` +
      (i > 0 ? `,fade=t=in:st=0:d=${FADE}` : "") +
      (i < segs.length - 1 ? `,fade=t=out:st=${fadeOut}:d=${FADE}` : "") +
      `[v${i}]`
    );

    f.push(
      `[0:a]atrim=${s.start}:${s.end},asetpts=PTS-STARTPTS` +
      (i > 0 ? `,afade=t=in:st=0:d=${FADE}` : "") +
      (i < segs.length - 1 ? `,afade=t=out:st=${fadeOut}:d=${FADE}` : "") +
      `[a${i}]`
    );

    c.push(`[v${i}][a${i}]`);
  });

  f.push(`${c.join("")}concat=n=${segs.length}:v=1:a=1[outv][outa]`);
  return f.join(";");
}

/* ================= QUEUE ================= */
async function runQueue() {
  if (activeJobs >= MAX_CONCURRENT_JOBS) return;
  const job = queue.shift();
  if (!job) return;

  activeJobs++;
  job.status = "PROCESSING";

  try {
    for (const f of job.files) {
      f.status = "PROCESSING";
      await processFile(job, f);
      f.status = "DONE";
    }
    job.status = "DONE";
  } catch (e) {
    job.status = "ERROR";
    console.error(e);
  } finally {
    activeJobs--;
    runQueue();
  }
}

/* ================= REAL JUMPCUT SAFE ================= */
async function processFile(job, file) {
  const parsed = path.parse(file.originalName);
  const outputName = `${parsed.name} finished${parsed.ext}`;
  const outputPath = path.join(job.outputDir, outputName);

  const duration = await getDuration(file.inputPath);
  const silences = await detectSilences(file.inputPath);

  if (silences.length === 0) {
    fs.copyFileSync(file.inputPath, outputPath);
    safeDelete(file.inputPath);
    file.outputName = outputName;
    return;
  }

  const keeps = buildKeepSegments(silences, duration);
  const graph = buildFilterGraph(keeps);

  await runFFmpeg([
    "-i", file.inputPath,
    "-filter_complex", graph,
    "-map", "[outv]",
    "-map", "[outa]",
    "-y",
    outputPath
  ]);

  safeDelete(file.inputPath);
  file.outputName = outputName;
}

/* ================= MULTER ================= */
const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, req.job.uploadDir);
  },
  filename(req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { files: MAX_FILES, fileSize: MAX_FILE_SIZE }
});

/* ================= JOB CREATION ================= */
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const jobId = uid();
  const jobDir = path.join(BASE_DIR, jobId);
  const uploadDir = path.join(jobDir, "uploads");
  const outputDir = path.join(jobDir, "outputs");

  ensure(uploadDir);
  ensure(outputDir);

  const job = {
    id: jobId,
    status: "QUEUED",
    files: [],
    uploadDir,
    outputDir
  };

  jobs.set(jobId, job);
  req.job = job;

  setTimeout(() => {
    fs.rm(jobDir, { recursive: true, force: true }, () => {});
    jobs.delete(jobId);
  }, JOB_TTL);

  next();
});

/* ================= ROUTES ================= */
app.post("/upload", upload.array("files", MAX_FILES), (req, res) => {
  const job = req.job;

  req.files.forEach(f => {
    job.files.push({
      originalName: f.originalname,
      inputPath: f.path,
      outputName: null,
      status: "QUEUED"
    });
  });

  queue.push(job);
  runQueue();
  res.redirect(`/status/${job.id}`);
});

app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.send("This job has expired.");

  const done = job.status === "DONE";

  res.send(`
<!DOCTYPE html>
<html>
<head>
<title>Processing</title>
<style>
body { font-family: Arial; background:#0f0f0f; color:white; padding:30px }
a { color:#4caf50 }
</style>
${!done ? `<script>setTimeout(() => location.reload(), 2000)</script>` : ""}
</head>
<body>

<h2>${done ? "Processing complete" : "Processing…"}</h2>

<ul>
${job.files.map(f => `
<li>
${f.originalName} — ${f.status}
${f.outputName ? ` - <a href="/download/${job.id}/${encodeURIComponent(f.outputName)}">Download</a>` : ""}
</li>
`).join("")}
</ul>

${done ? `<a href="/">Upload more files</a>` : `<p>Please wait…</p>`}

</body>
</html>
`);
});

app.get("/download/:jobId/:file", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.send("Expired");
  res.download(path.join(job.outputDir, req.params.file));
});

/* ================= START ================= */
ensure(BASE_DIR);
app.listen(PORT, () => {
  console.log(`JUMPCUT-SAFE running on http://localhost:${PORT}`);
});
