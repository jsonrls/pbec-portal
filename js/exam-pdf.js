import { PDFDocument, StandardFonts, rgb } from "../assets/vendor/pdf-lib-1.17.1/pdf-lib.esm.min.js";
import { examQuestionIds, resolveExamQuestions } from "./exam-data.js";

export const PDF_LAYOUT = Object.freeze({ width: 612, height: 936, margin: 28, fontSize: 10, lineHeight: 11 });
export const INSTRUCTIONS = "Select the correct answer for each of the following questions. Mark only one answer for each item by shading the box corresponding to the letter of your choice on the answer sheet provided.";
export const CLOSING_NOTICE = "SUBMIT THIS TEST QUESTIONS SET TOGETHER WITH THE ANSWER SHEET TO YOUR WATCHERS. BRINGING THE TEST QUESTIONS SET OUT OF THE ROOM WILL BE A GROUND FOR DISCIPLINARY ACTION";

export function subjectHeader(subject) {
    const name = String(subject || "").trim();
    switch (name.toLowerCase()) {
        case "esas": case "engineering sciences and allied subjects": return "ENGINEERING SCIENCES AND ALLIED SUBJECTS";
        case "professional ee": case "professional electrical engineering subjects":
        case "professionla electrical engineering subjects": return "PROFESSIONAL ELECTRICAL ENGINEERING SUBJECTS";
        default: return name.toUpperCase();
    }
}

export function optionColumns(widths, contentWidth, padding = 2) {
    return [4, 2, 1].find(columns => columns === 1 || widths.every(width => width <= contentWidth / columns - 2 * padding));
}

function cleanText(value) {
    return String(value ?? "").normalize("NFC").replace(/\r\n?/g, "\n")
        .replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\u00A0/g, " ")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

function groupEnd(text, start) {
    const close = { "{": "}", "(": ")", "[": "]" }[text[start]];
    if (!close) return start;
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === text[start]) depth++;
        if (text[i] === close && --depth === 0) return i + 1;
    }
    throw new Error("An equation has an unclosed group. Correct it before exporting.");
}

function delimiterEnd(text, close, start) {
    let index = text.indexOf(close, start);
    while (index >= 0) {
        let escapes = 0;
        for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) escapes++;
        if (escapes % 2 === 0) return index;
        index = text.indexOf(close, index + close.length);
    }
    return -1;
}

// Explicit TeX and bare formula tokens are rendered separately, leaving prose as PDF text.
export function splitExamText(value) {
    const text = cleanText(value), parts = [];
    const candidate = /\$\$|\$|\\\(|\\\[|\\[A-Za-z]+|(?:sqrt|sq\.?\s*rt\.?)\s*\(|√|[^\s{}\\$]+/gy;
    let index = 0;
    const append = (source, math = false) => {
        if (!source) return;
        const previous = parts.at(-1);
        if (!math && previous && !previous.math) previous.source += source;
        else parts.push({ source, math });
    };
    while (index < text.length) {
        if (/\s/.test(text[index])) { append(text[index++]); continue; }
        if (text.slice(index, index + 2) === "\\$") { append("$"); index += 2; continue; }
        candidate.lastIndex = index;
        const match = candidate.exec(text);
        if (!match) { append(text[index++]); continue; }
        let token = match[0], end = candidate.lastIndex;
        const close = { "$$": "$$", "$": "$", "\\(": "\\)", "\\[": "\\]" }[token];
        if (close) {
            const stop = delimiterEnd(text, close, end);
            // Unpaired monetary amounts, including "$5 and $10", remain prose.
            if (token === "$" && /^\d[\d,.]*(?:\s|$)/.test(text.slice(end)) && (stop < 0 || /^\d/.test(text.slice(stop + 1)))) {
                append("$"); index = end; continue;
            }
            if (stop < 0) throw new Error("An equation has an unclosed delimiter. Correct it before exporting.");
            append(text.slice(end, stop), true);
            index = stop + close.length;
            continue;
        }
        let math = /^\\[A-Za-z]+/.test(token) || /[\^_√⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻₀-₉α-ωΑ-Ω∫∑∞≤≥≠]/.test(token) || /^(sqrt|sq\.?\s*rt\.?)\s*\(/i.test(token);
        if (/^\\[A-Za-z]+/.test(token)) {
            let cursor = end;
            while (cursor < text.length) {
                const spaces = /^\s*/.exec(text.slice(cursor))[0].length;
                const start = cursor + spaces;
                if (!["{", "["].includes(text[start])) break;
                cursor = groupEnd(text, start);
                end = cursor;
            }
            token = text.slice(index, end);
        } else if (math && /\($/.test(token)) {
            end = groupEnd(text, end - 1);
            token = text.slice(index, end);
        } else if (token === "√") {
            if ("({[".includes(text[end] || " ")) end = groupEnd(text, end);
            else end += /^[A-Za-z0-9.]+/.exec(text.slice(end))?.[0].length || 0;
            token = text.slice(index, end);
        } else if (math) {
            // A script's braced argument may include whitespace.
            if (text[end] === "{" && /[\^_]$/.test(token)) {
                end = groupEnd(text, end);
                token = text.slice(index, end);
            }
            const punctuation = /[.,;:?!]+$/.exec(token)?.[0] || "";
            if (punctuation) { token = token.slice(0, -punctuation.length); end -= punctuation.length; }
        }
        append(token, math);
        index = end;
    }
    return parts;
}

export function normalizeEquation(source) {
    const supers = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "-" };
    const roots = /(?:\bsqrt|\bsq\.?\s*rt\.?|√)\s*(?=[({])/gi;
    let normalized = "", cursor = 0, match;
    while ((match = roots.exec(source))) {
        if (source[match.index - 1] === "\\") continue;
        const start = roots.lastIndex, end = groupEnd(source, start);
        normalized += source.slice(cursor, match.index) + `\\sqrt{${normalizeEquation(source.slice(start + 1, end - 1))}}`;
        cursor = end;
        roots.lastIndex = end;
    }
    normalized += source.slice(cursor);
    return normalized.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+/g, run => `^{${[...run].map(ch => supers[ch]).join("")}}`)
        .replace(/[₀-₉]+/g, run => `_{${[...run].map(ch => ch.charCodeAt(0) - 0x2080).join("")}}`)
        .replace(/√([A-Za-z0-9.]+)/g, "\\sqrt{$1}").replace(/−/g, "-")
        .replace(/×/g, "\\times ").replace(/÷/g, "\\div ");
}

let mathReady;
async function loadMath() {
    if (!mathReady) {
        mathReady = new Promise((resolve, reject) => {
            globalThis.MathJax = {
                startup: { typeset: false },
                options: { enableMenu: false },
                tex: { packages: ["base", "ams"], formatError: (_, error) => { throw error; } },
                svg: { fontCache: "none" }
            };
            const script = document.createElement("script");
            script.src = new URL("../assets/vendor/mathjax-3.2.2/tex-svg.js", import.meta.url).href;
            script.onload = () => globalThis.MathJax.startup.promise.then(resolve, reject);
            script.onerror = () => { script.remove(); reject(new Error("The equation renderer could not load. Check your connection and retry.")); };
            document.head.append(script);
        }).catch(error => { mathReady = null; throw error; });
    }
    await mathReady;
    return globalThis.MathJax;
}

async function equationImage(pdf, source) {
    if (/\\(?:require|href|url|includegraphics|html\w*|class|style)\b/i.test(source)) {
        throw new Error("An equation uses unsupported external content. Correct it before exporting.");
    }
    const math = await loadMath();
    const element = await math.tex2svgPromise(normalizeEquation(source), { display: false, em: 10, ex: 5, containerWidth: 556 });
    if (element.querySelector("[data-mml-node='merror']")) throw new Error("An equation could not be rendered. Correct it before exporting.");
    const svg = element.querySelector("svg");
    const [, , boxWidth, boxHeight] = svg.getAttribute("viewBox").split(/\s+/).map(Number);
    const width = boxWidth / 100, height = boxHeight / 100;
    const pixelsWide = Math.ceil(width * 4), pixelsHigh = Math.ceil(height * 4);
    if (![width, height].every(n => Number.isFinite(n) && n > 0) || pixelsWide * pixelsHigh > 16000000 || pixelsWide > 16384 || pixelsHigh > 16384) {
        throw new Error("An equation is too large to export legibly. Shorten it before exporting.");
    }
    svg.setAttribute("width", pixelsWide);
    svg.setAttribute("height", pixelsHigh);
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.style.color = "#000";
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    try {
        const image = new Image();
        await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = () => reject(new Error("An equation image could not be prepared. Retry the download.")); image.src = url; });
        const canvas = document.createElement("canvas");
        canvas.width = pixelsWide;
        canvas.height = pixelsHigh;
        canvas.getContext("2d").drawImage(image, 0, 0);
        return { image: await pdf.embedPng(canvas.toDataURL("image/png")), width, height };
    } finally { URL.revokeObjectURL(url); }
}

export function prepareExamQuestions(exam, questions, set = "A") {
    const ordered = resolveExamQuestions(exam, questions, set);
    if (!ordered.length) throw new Error(`Set ${set} has no questions to export.`);
    return ordered.map((question, index) => {
        if (!cleanText(question.questionText).trim()) throw new Error(`Question ${index + 1} is empty. Correct it before exporting.`);
        const options = ["A", "B", "C", "D"].map(label => ({ label, text: cleanText(question[`option${label}`]) }));
        if (options.some(option => !option.text.trim())) throw new Error(`Question ${index + 1} has a missing answer choice. Correct it before exporting.`);
        // Only student-facing content crosses the PDF boundary, never correctAnswer or showAnswers.
        return { text: cleanText(question.questionText), options };
    });
}

export async function createExamPdf({ exam, questions, set = "A", subject = exam?.subject, onProgress = () => {} }) {
    const ordered = prepareExamQuestions(exam, questions, set);
    const header = subjectHeader(subject);
    if (!header) throw new Error("The exam subject is missing. Set the subject before exporting.");
    const pdf = await PDFDocument.create();
    const normal = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const { width, height, margin, fontSize, lineHeight } = PDF_LAYOUT;
    const contentWidth = width - margin * 2, numberWidth = contentWidth * .05, questionWidth = contentWidth - numberWidth - 4;
    const equationCache = new Map();
    let page = pdf.addPage([width, height]), y = height - margin;
    const newPage = () => { page = pdf.addPage([width, height]); y = height - margin; };
    const ensure = needed => { if (y - needed < margin) newPage(); };

    async function runs(value, font = normal, size = fontSize) {
        const result = [];
        for (const part of splitExamText(value)) {
            if (part.math) {
                if (!equationCache.has(part.source)) equationCache.set(part.source, await equationImage(pdf, part.source));
                result.push(equationCache.get(part.source));
            } else {
                for (const text of part.source.split(/(\n|[^\S\n]+)/).filter(Boolean)) {
                    try { result.push({ text, width: font.widthOfTextAtSize(text === "\n" ? "" : text, size), height: size, font, size }); }
                    catch { throw new Error(`The character in "${text}" needs equation markup (\\(…\\)). Correct it before exporting.`); }
                }
            }
        }
        return result;
    }

    function wrap(items, maxWidth) {
        const lines = [];
        let line = [], used = 0;
        const flush = () => { while (line.at(-1)?.text?.match(/^\s+$/)) line.pop(); lines.push(line); line = []; used = 0; };
        for (const item of items) {
            if (item.text === "\n") { flush(); continue; }
            if (!line.length && item.text?.match(/^\s+$/)) continue;
            if (item.width > maxWidth) {
                if (item.image) throw new Error("An equation is wider than the page. Split it into shorter expressions before exporting.");
                // Split long prose tokens without shrinking the document's 10pt text.
                for (const character of item.text) {
                    const piece = { ...item, text: character, width: item.font.widthOfTextAtSize(character, item.size) };
                    if (used + piece.width > maxWidth && line.length) flush();
                    line.push(piece); used += piece.width;
                }
                continue;
            }
            if (used + item.width > maxWidth && line.length) flush();
            if (!line.length && item.text?.match(/^\s+$/)) continue;
            line.push(item); used += item.width;
        }
        if (line.length) flush();
        return lines.map(items => ({ items, height: Math.max(lineHeight, ...items.map(item => item.height + (item.image ? 2 : 1))), width: items.reduce((sum, item) => sum + item.width, 0) }));
    }

    function drawLine(line, x, top, justifyWidth) {
        const whitespace = line.items.filter(item => item.text?.match(/^ +$/)).length;
        const extra = whitespace && justifyWidth ? Math.max(0, justifyWidth - line.width) / whitespace : 0;
        for (const item of line.items) {
            if (item.image) page.drawImage(item.image, { x, y: top - (line.height + item.height) / 2, width: item.width, height: item.height });
            else page.drawText(item.text, { x, y: top - (line.height + item.size) / 2 + 2, font: item.font, size: item.size, color: rgb(0, 0, 0) });
            x += item.width + (item.text?.match(/^ +$/) ? extra : 0);
        }
    }
    function paragraph(lines, x = margin, justify = false) {
        lines.forEach((line, index) => { ensure(line.height); drawLine(line, x, y, justify && index < lines.length - 1 ? contentWidth : undefined); y -= line.height; });
    }
    const heading = wrap(await runs(header, bold, 14), contentWidth);
    for (const line of heading) { drawLine(line, margin + (contentWidth - line.width) / 2, y); y -= line.height; }
    y -= 5;
    const divider = () => { page.drawLine({ start: { x: margin, y }, end: { x: width - margin, y }, thickness: .8, color: rgb(0, 0, 0) }); y -= 5; };
    divider();
    paragraph(wrap([...(await runs("Instruction: ", bold)), ...(await runs(INSTRUCTIONS))], contentWidth), margin, true);
    y -= 5;
    divider();
    paragraph(wrap(await runs("Multiple Choice", bold), contentWidth));
    y -= 2;
    for (let index = 0; index < ordered.length; index++) {
        const question = ordered[index];
        onProgress(index + 1, ordered.length);
        let textLines, choices;
        try {
            textLines = wrap(await runs(question.text), questionWidth);
            choices = await Promise.all(question.options.map(async option => runs(`${option.label}. ${option.text}`)));
        } catch (error) { throw new Error(`Question ${index + 1}: ${error.message}`); }
        const columns = optionColumns(choices.map(items => items.reduce((sum, item) => sum + item.width, 0)), questionWidth);
        const cellWidth = questionWidth / columns;
        const choiceLines = choices.map(items => wrap(items, cellWidth - 4));
        const rows = [];
        for (let offset = 0; offset < choices.length; offset += columns) {
            const cells = choiceLines.slice(offset, offset + columns);
            const rowHeight = Math.max(...cells.map(lines => lines.reduce((sum, line) => sum + line.height, 0))) + 2;
            rows.push({ cells, height: rowHeight });
        }
        const blockHeight = textLines.reduce((sum, line) => sum + line.height, 0) + rows.reduce((sum, row) => sum + row.height, 0) + 4;
        // Keep ordinary questions together; long questions continue line by line without clipping.
        ensure(Math.min(blockHeight, height - margin * 2));
        page.drawText(`${index + 1}.`, { x: margin, y: y - 9, font: bold, size: fontSize });
        paragraph(textLines, margin + numberWidth);
        for (const row of rows) {
            const maxLines = Math.max(...row.cells.map(lines => lines.length));
            for (let i = 0; i < maxLines; i++) {
                const rowLineHeight = Math.max(lineHeight, ...row.cells.map(lines => lines[i]?.height || 0));
                ensure(rowLineHeight);
                row.cells.forEach((lines, column) => { if (lines[i]) drawLine(lines[i], margin + numberWidth + column * cellWidth + 2, y); });
                y -= rowLineHeight;
            }
            y -= 2;
        }
        y -= 4;
    }
    const notice = wrap(await runs(CLOSING_NOTICE), contentWidth);
    ensure(29 + notice.reduce((sum, line) => sum + line.height, 0));
    y -= 10;
    const end = wrap(await runs("*** END ***"), contentWidth)[0];
    drawLine(end, margin + (contentWidth - end.width) / 2, y);
    y -= end.height + 8;
    paragraph(notice, margin, true);
    return pdf.save();
}

export async function downloadExamPdf(options) {
    const bytes = await createExamPdf(options);
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const link = document.createElement("a");
    link.href = url;
    const name = String(options.exam.examName || "Exam").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 100);
    link.download = `${name} - Set ${options.set || "A"}.pdf`;
    document.body.append(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
    return bytes;
}

export function bindExamPdfControls({ getExam, getQuestions, getSubject, onSetChange }) {
    const button = document.getElementById("btn-download-pdf");
    const select = document.getElementById("exam-set");
    const status = document.getElementById("pdf-export-status");
    let busy = false;
    function refresh() {
        const exam = getExam();
        if (!exam) return;
        select.options[1].disabled = !examQuestionIds(exam, "B").length;
        select.disabled = busy;
        const set = select.value;
        let ordered = [];
        try {
            ordered = resolveExamQuestions(exam, getQuestions(), set);
            onSetChange(set, ordered);
            prepareExamQuestions(exam, getQuestions(), set);
            button.disabled = busy;
            status.textContent = "";
        } catch (error) {
            if (!ordered.length) onSetChange(set, []);
            button.disabled = true;
            status.textContent = `PDF unavailable: ${error.message} Reload the exam after correcting its questions.`;
        }
    }
    select.addEventListener("change", refresh);
    button.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        button.disabled = true;
        select.disabled = true;
        button.setAttribute("aria-busy", "true");
        button.textContent = "Preparing PDF…";
        status.textContent = "Preparing all questions for download.";
        try {
            await downloadExamPdf({ exam: getExam(), questions: getQuestions(), subject: getSubject(), set: select.value,
                onProgress: (current, total) => { status.textContent = `Preparing question ${current} of ${total}.`; } });
            status.textContent = `Set ${select.value} PDF downloaded.`;
        } catch (error) {
            console.error("Exam PDF export failed", { name: error.name });
            status.textContent = `PDF download failed: ${error.message} Correct the problem and retry.`;
        } finally {
            busy = false;
            button.disabled = false;
            select.disabled = false;
            button.removeAttribute("aria-busy");
            button.textContent = "Download exam PDF";
        }
    });
    return { refresh };
}
