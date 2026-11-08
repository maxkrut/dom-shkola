/* Pure source-bound region planning, shared by offline publication and legacy viewer. */
const normalize = (value) => String(value || "").toLowerCase().replaceAll("ё", "е")
  .replace(/набережная/g, "наб").replace(/проспект/g, "пр").replace(/переулок/g, "пер")
  .replace(/улица/g, "ул").replace(/[^а-яa-z0-9]+/g, " ").trim();
const bounds = (words) => [Math.min(...words.map(w => w[1])), Math.min(...words.map(w => w[2])), Math.max(...words.map(w => w[3])), Math.max(...words.map(w => w[4]))];

export function localPdfHref(rawFile, page = 0) {
  const raw = String(rawFile || "").replaceAll("\\", "/");
  if (!raw.startsWith("raw/") || raw.split("/").includes("..") || /[?#]/.test(raw) || !/\.pdf$/i.test(raw)) return "";
  return `../../${raw.split("/").map(encodeURIComponent).join("/")}${Number.isInteger(page) && page > 0 ? `#page=${page}` : ""}`;
}

function matchingPhrase(words, phrase) {
  const target = normalize(phrase);
  if (!target) return null;
  const matches = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= Math.min(start + 12, words.length); end += 1) {
      if (normalize(words.slice(start, end).map(w => w[0]).join(" ")) === target) matches.push(bounds(words.slice(start, end)));
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function matchingHouse(words, literal) {
  const target = normalize(literal);
  if (!target) return null;
  const matches = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= Math.min(start + 8, words.length); end += 1) {
      const selection = words.slice(start, end);
      if (normalize(selection.map(word => word[0]).join(" ")) !== target) continue;
      // A base number must not stand in for a corpus, litera, fraction or range.
      const previous = words[start - 1]?.[0] || "";
      const next = words[end]?.[0] || "";
      if (/^(?:к(?:орп(?:ус)?)?|лит(?:ера)?|стр(?:оение)?|сооружение)[.]?$/i.test(next) || /^[/–—-]/.test(next) || /[/–—-]$/.test(previous)) continue;
      if (end < words.length && !/[,;]$/.test(selection.at(-1)[0]) && !/^[,;]/.test(next)) continue;
      matches.push(bounds(selection));
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function schoolAnchor(page, number) {
  if (!/^\d+$/.test(String(number || ""))) return null;
  const lines = [];
  for (const word of page.words || []) {
    let line = lines.find(item => Math.abs(item.y - word[2]) < 3);
    if (!line) { line = {y:word[2], words:[]}; lines.push(line); }
    line.words.push(word);
  }
  const boxes = [];
  for (const line of lines) {
    const words = line.words.sort((a,b) => a[1]-b[1]);
    for (let start = 0; start < words.length; start += 1) {
      if (!/^(ГБОУ|СОШ|школа|лицей|гимназия)$/i.test(words[start][0])) continue;
      for (let end = start+1; end <= Math.min(start+7, words.length); end += 1) {
        const text = words.slice(start,end).map(w=>w[0]).join(" ");
        if (new RegExp(`№\\s*${number}\\s*$`).test(text)) {
          const box = bounds(words.slice(start,end));
          if (!boxes.some(b => b[2] === box[2] && Math.abs(b[1]-box[1])<3)) boxes.push(box);
          break;
        }
      }
    }
  }
  return boxes.length === 1 ? boxes[0] : null;
}

// Visually checked against physical page 3; OCR reads the printed 6 as «б».
// This correction is bound to the immutable file hash, school and literal.
const admiraltySha = "25aa949485b32922fa3edb630b3c7eeadababe666ab9ec8286e63f9b48544820";
function verifiedAnchors(spec, document) {
  if (spec.rule || !spec.literal) return null;
  if (document.sha256 !== admiraltySha || Number(spec.page) !== 3 || String(spec.school) !== "225") return null;
  const street = normalize(spec.street);
  const school = [147.5,282.6,259.5,296.8];
  if (street === "адмиралтейская наб" && ["6","10"].includes(spec.house)) {
    return {school, address:[[269.3,284.2,385.3,297.5], spec.house === "6" ? [425.6,284.2,435.2,297.5] : [438.3,284.2,452.7,297.5]]};
  }
  if (street === "адмиралтейский проезд" && spec.house === "2") {
    return {school, address:[[269.3,313.4,415.3,326.7],[439.3,313.4,449,326.7]]};
  }
  return null;
}

export function planEvidence(spec, document) {
  if (!/^[a-f0-9]{64}$/.test(document.sha256 || "")) return null;
  if (spec.sha256 && document.sha256 !== spec.sha256) return null;
  if (document.source_raw_file !== spec.rawFile) return null;
  const number = Number(spec.page);
  if (!Number.isInteger(number) || number < 1) return null;
  const page = document.pages.find(item => item.number === number);
  if (!page || !(page.width > 0 && page.height > 0)) return null;
  const hasY = spec.y !== "" && spec.y != null && Number.isFinite(Number(spec.y));
  const y = Number(spec.y);
  const line = hasY && y >= 0 && y < page.height
    ? (page.words || []).filter(word => Math.abs(word[2]-y) < 5).sort((a,b)=>a[1]-b[1]) : [];
  const verified = verifiedAnchors(spec, document);
  const street = matchingPhrase(line, spec.street);
  // Highlight a house only when its full literal is one unambiguous phrase
  // to the right of the street. A range/expanded member is not a PDF literal.
  const houseWords = street ? line.filter(word => word[1] >= street[2]) : [];
  const house = !spec.rule && spec.literal ? matchingHouse(houseWords, spec.house) : null;
  const address = verified?.address || (street ? [street, ...(house ? [house] : [])] : []);
  const school = verified?.school || schoolAnchor(page, spec.school);
  const lineBounds = line.length ? bounds(line) : null;
  let crop = null;
  if (verified || street) {
    const box = bounds(address.map(box => ["",...box]));
    crop = [Math.max(0,box[0]-7),Math.max(0,box[1]-6),Math.min(page.width,Math.max(box[2]+10,box[0]+280))-Math.max(0,box[0]-7),Math.min(Math.max(30,box[3]-box[1]+12),page.height-Math.max(0,box[1]-6))];
  } else if (lineBounds) {
    crop = [Math.max(0,lineBounds[0]-8),Math.max(0,y-10),Math.min(page.width,lineBounds[2]+8)-Math.max(0,lineBounds[0]-8),Math.min(65,page.height-Math.max(0,y-10))];
  }
  return {page, crop, school, address, exact: Boolean(verified || house)};
}
