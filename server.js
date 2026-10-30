/* ============================================================
 * 공주 일자리 — 백엔드 서버 (FIT JOB, 국립공주대 HUSS 공공데이터 해커톤)
 * - 정적 파일 서빙 (gongju-jobs/)
 * - KOSIS 통계자료 API 프록시
 *   · GET /api/kosis/employment/gongju?year=YYYY&half=1|2
 *     → 공주시(3402) 연령별 취업자 수·고용률 (DT_1ES3A03_A01S)
 * - 행정안전부 1365 봉사참여정보서비스 프록시
 *   · GET /api/volunteer?pageNo=1        → 공주시 봉사활동 목록
 *   · GET /api/volunteer/{등록번호}       → 봉사활동 상세
 * - 인증키(KOSIS_API_KEY, VOLUNTEER_SERVICE_KEY)는 .env에서만 읽으며
 *   코드·응답·로그에 출력하지 않는다.
 * ============================================================ */
"use strict";

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

/* ---------------- 설정 ---------------- */

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const STATIC_DIR = path.join(ROOT, "gongju-jobs");

// .env 로딩 (간단 파서: KEY=VALUE 라인만 처리)
function loadEnv(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const val = m[2].replace(/^["']|["']$/g, "");
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    /* .env 없으면 무시 */
  }
}
loadEnv(path.join(ROOT, ".env"));

const KOSIS_API_KEY = process.env.KOSIS_API_KEY || "";

// KOSIS 통계자료 API — 통계표 선택 방식 (개발가이드 devGuide_0201 기준)
const KOSIS_ENDPOINT =
  "https://kosis.kr/openapi/Param/statisticsParameterData.do?method=getList";

// 확인된 상수만 사용 (2026-10-30 실제 호출로 검증됨)
const KOSIS_PARAMS = {
  orgId: "101",              // 통계청
  tblId: "DT_1ES3A03_A01S",  // 시군구 연령별 취업자 및 고용률
  objL1: "3402",             // 공주시
};
// C2 연령 분류 코드
const AGE_CODES = {
  total: { code: "000", label: "계" },
  "15-29": { code: "010", label: "15~29세" },
  "30-49": { code: "020", label: "30~49세" },
  "50-64": { code: "030", label: "50~64세" },
  "65+": { code: "040", label: "65세 이상" },
};
// 항목 코드
const ITEM_EMPLOYED = "T00";  // 취업자 (천명)
const ITEM_RATE = "T12";      // 고용률 (%)

/* ---------------- 1365 봉사활동 API (행정안전부) ---------------- */

const VOLUNTEER_SERVICE_KEY = process.env.VOLUNTEER_SERVICE_KEY || "";

// 공공데이터포털 「1365 봉사참여정보서비스」
const VOLUNTEER_ENDPOINT = "https://apis.data.go.kr/1741000/volunteerPartcptnService";
const VOLUNTEER_LIST_PATH = "/getVltrAreaList";        // 지역별 봉사활동 목록
const VOLUNTEER_ITEM_PATH = "/getVltrPartcptnItem";    // 봉사활동 상세정보

// 공주시 고정 조회 조건
const GONGJU_VOLUNTEER_PARAMS = {
  ageNo: "1",          // 전체 연령
  numOfRows: "20",     // 페이지당 건수
  schSido: "6440000",  // 충청남도 공주시 (시도 코드)
  schSign1: "4500000", // 시군구 코드
};

// 1365 상세 페이지 URL — 사이트에서 실제로 사용하는 GET 형식 (2026-10-31 실사 확인)
// 활동인증 봉사 상세보기: 등록번호만으로 접근 가능
const VOLUNTEER_DETAIL_URL =
  "https://www.1365.go.kr/vols/1572247923954/partcptn/onlinePartCptn.do?type=show&progrmRegistNo=";

/* ---------------- 공통 유틸 ---------------- */

// 문자열 마스킹: 인증키가 로그·오류 메시지에 노출되지 않도록 한다
function maskSecret(text) {
  let out = String(text);
  if (VOLUNTEER_SERVICE_KEY) {
    out = out.split(VOLUNTEER_SERVICE_KEY).join("***")
             .split(encodeURIComponent(VOLUNTEER_SERVICE_KEY)).join("***");
  }
  if (KOSIS_API_KEY) {
    out = out.split(KOSIS_API_KEY).join("***")
             .split(encodeURIComponent(KOSIS_API_KEY)).join("***");
  }
  return out;
}

// XML 태그 하나의 텍스트 내용 추출 (첫 번째 매치, CDATA·엔티티 처리)
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp("<" + tag + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + tag + ">"));
  if (!m) return "";
  const cdata = m[1].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  const raw = cdata ? cdata[1] : m[1];
  return raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}

// 공공데이터포털 XML 오류 응답 판별 → Error | null
function parseXmlError(xml) {
  if (!/<OpenAPI_ServiceResponse>/.test(xml) && !/<cmmMsgHeader>/.test(xml)) return null;
  const errMsg = xmlTag(xml, "errMsg");
  const authMsg = xmlTag(xml, "returnAuthMsg");
  const reason = xmlTag(xml, "returnReasonCode");
  if (!errMsg && !authMsg) return null;
  const err = new Error("1365 API 오류: " + [errMsg, authMsg].filter(Boolean).join(" / "));
  // 20=키 미포함, 30=미등록 키, 22/31=만료·제한 → 설정 문제(503)
  err.status = ["20", "30", "22", "31"].includes(reason) ? 503 : 502;
  err.expose = true; // 사용자가 조치 가능한 메시지이므로 그대로 전달
  return err;
}

// XML <item> 단위를 {tag: text} 객체로 분해
function parseXmlItems(xml) {
  const items = [];
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const obj = {};
    const fieldRe = /<([A-Za-z_][A-Za-z0-9_]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
    let f;
    while ((f = fieldRe.exec(m[1])) !== null) {
      const cdata = f[2].match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
      const raw = cdata ? cdata[1] : f[2];
      obj[f[1]] = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
                     .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
    }
    items.push(obj);
  }
  return items;
}

// 모집 상태 원본 코드(se) → 사람이 읽는 라벨 (1=모집대기, 2=모집중, 3=모집완료)
function progrmSttusLabel(se) {
  switch (String(se)) {
    case "1": return "모집대기";
    case "2": return "모집중";
    case "3": return "모집완료";
    case "4": return "중단";
    case "5": return "취소";
    case "6": return "지역문제로 중단";
    case "7": return "기관문제로 중단";
    case "8": return "접수중";
    default: return "기타(" + se + ")";
  }
}

// 1365 API 공통 호출 → XML 문자열
async function fetchVolunteerXml(pathName, extraParams) {
  if (!VOLUNTEER_SERVICE_KEY) {
    const err = new Error("VOLUNTEER_SERVICE_KEY가 설정되지 않았습니다. 루트의 .env에 키를 넣어주세요.");
    err.status = 503;
    err.expose = true;
    throw err;
  }

  const params = new URLSearchParams({
    ...GONGJU_VOLUNTEER_PARAMS,
    ...extraParams,
    serviceKey: VOLUNTEER_SERVICE_KEY, // URL에만 사용, 로그·응답에 노출 금지
  });

  const res = await httpsGet(VOLUNTEER_ENDPOINT + pathName + "?" + params.toString());
  if (res.status !== 200) {
    const err = new Error("1365 API가 HTTP " + res.status + "를 반환했습니다.");
    err.status = 502;
    throw err;
  }

  const xmlErr = parseXmlError(res.body);
  if (xmlErr) throw xmlErr;

  return res.body;
}

/* ---------------- 1365 조회 함수 ---------------- */

/**
 * 공주시 봉사활동 목록 조회
 * @param {number} pageNo 페이지 번호
 */
async function fetchVolunteerList(pageNo) {
  const xml = await fetchVolunteerXml(VOLUNTEER_LIST_PATH, {
    pageNo: String(pageNo || 1),
  });

  const items = parseXmlItems(xml);
  if (items.length === 0) {
    const err = new Error("조회된 봉사활동이 없습니다. (공주시 조건: " +
      GONGJU_VOLUNTEER_PARAMS.schSido + "/" + GONGJU_VOLUNTEER_PARAMS.schSign1 + ")");
    err.status = 404;
    err.expose = true;
    throw err;
  }

  const totalCount = parseInt(xmlTag(xml, "totalCount"), 10) || items.length;

  return {
    source: "행정안전부 1365 봉사참여정보서비스 (공공데이터포털)",
    region: { sido: GONGJU_VOLUNTEER_PARAMS.schSido, sigungu: GONGJU_VOLUNTEER_PARAMS.schSign1, name: "공주시" },
    page: pageNo || 1,
    numOfRows: Number(GONGJU_VOLUNTEER_PARAMS.numOfRows),
    totalCount,
    items: items.map((it) => ({
      progrmRegistNo: it.progrmRegistNo || null,
      progrmSj: it.progrmSj || null,
      nanmmbyNm: it.nanmmbyNm || null,
      mnnstNm: it.mnnstNm || null,
      srvcClCode: it.srvcClCode || null,
      noticeBgnde: it.noticeBgnde || null,
      noticeEndde: it.noticeEndde || null,
      progrmBgnde: it.progrmBgnde || null,
      progrmEndde: it.progrmEndde || null,
      progrmSttusSe: it.progrmSttusSe || null,
      progrmSttusNm: progrmSttusLabel(it.progrmSttusSe),
      rcritNmpr: it.rcritNmpr || null,
      appTotal: it.appTotal || null,
      actBeginTm: it.actBeginTm || null,
      actEndTm: it.actEndTm || null,
      actWkdy: it.actWkdy || null,
      actPlace: it.actPlace || null,
      areaAddress1: it.areaAddress1 || null,
      areaLalo1: it.areaLalo1 || null,
      telno: it.telno || null,
      adultPosblAt: it.adultPosblAt || null,
      yngbgsPosblAt: it.yngbgsPosblAt || null,
      grpPosblAt: it.grpPosblAt || null,
      applyUrl: it.progrmRegistNo ? VOLUNTEER_DETAIL_URL + it.progrmRegistNo : null,
    })),
  };
}

/**
 * 봉사활동 상세 조회 (등록번호)
 * @param {string} programId 프로그램 등록번호
 */
async function fetchVolunteerDetail(programId) {
  if (!/^\d+$/.test(String(programId))) {
    const err = new Error("programId는 숫자 등록번호여야 합니다. (예: 2988739)");
    err.status = 400;
    err.expose = true;
    throw err;
  }

  const xml = await fetchVolunteerXml(VOLUNTEER_ITEM_PATH, {
    progrmRegistNo: String(programId),
  });

  const items = parseXmlItems(xml);
  if (items.length === 0) {
    const err = new Error("등록번호 " + programId + "에 해당하는 봉사활동이 없습니다.");
    err.status = 404;
    err.expose = true;
    throw err;
  }

  const it = items[0];
  return {
    source: "행정안전부 1365 봉사참여정보서비스 (공공데이터포털)",
    item: {
      progrmRegistNo: it.progrmRegistNo || programId,
      progrmSj: it.progrmSj || null,
      nanmmbyNm: it.nanmmbyNm || null,
      mnnstNm: it.mnnstNm || null,
      srvcClCode: it.srvcClCode || null,
      noticeBgnde: it.noticeBgnde || null,
      noticeEndde: it.noticeEndde || null,
      progrmBgnde: it.progrmBgnde || null,
      progrmEndde: it.progrmEndde || null,
      progrmCn: it.progrmCn || null,
      rcritNmpr: it.rcritNmpr || null,
      appTotal: it.appTotal || null,
      actBeginTm: it.actBeginTm || null,
      actEndTm: it.actEndTm || null,
      actWkdy: it.actWkdy || null,
      actPlace: it.actPlace || null,
      areaAddress1: it.areaAddress1 || null,
      areaLalo1: it.areaLalo1 || null,
      telno: it.telno || null,
      fxnum: it.fxnum || null,
      email: it.email || null,
      adultPosblAt: it.adultPosblAt || null,
      yngbgsPosblAt: it.yngbgsPosblAt || null,
      grpPosblAt: it.grpPosblAt || null,
      progrmSttusSe: it.progrmSttusSe || null,
      progrmSttusNm: progrmSttusLabel(it.progrmSttusSe),
      applyUrl: VOLUNTEER_DETAIL_URL + (it.progrmRegistNo || programId),
    },
  };
}

/* ---------------- KOSIS 호출 ---------------- */

// KOSIS 응답은 키가 따옴표 없는 비표준 JSON → 관대하게 복구
function lenientJsonParse(text) {
  const fixed = text.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3');
  return JSON.parse(fixed);
}

// HTTPS GET (리다이렉트 최대 3회 추적)
function httpsGet(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) return reject(new Error("너무 많은 리다이렉트"));
    https
      .get(url, { headers: { "User-Agent": "gongju-jobs/1.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return httpsGet(new URL(res.headers.location, url).toString(), depth + 1).then(resolve, reject);
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      })
      .on("error", reject);
  });
}

/**
 * 공주시 연령별 취업자·고용률 조회
 * @param {number} year    조회 연도 (예: 2026)
 * @param {1|2}   half     반기 (1 = 상반기, 2 = 하반기)
 * @returns {Promise<{source:string, region:{code,name}, table:{id,name},
 *   period:string, ages:Array<{key,label,employed thousands,rate %}>}>}
 */
async function fetchGongjuEmployment(year, half) {
  if (!KOSIS_API_KEY) {
    const err = new Error("KOSIS_API_KEY가 설정되지 않았습니다. 루트의 .env에 키를 넣어주세요.");
    err.status = 503;
    err.expose = true;
    throw err;
  }

  const prdDe = `${year}${half === 2 ? "02" : "01"}`; // 반기 시점: YYYY01(상) / YYYY02(하)

  const params = new URLSearchParams({
    ...KOSIS_PARAMS,
    objL2: "ALL",        // 연령 전체
    itmId: "ALL",        // 취업자·고용률 전체
    prdSe: "H",          // 반기 (KOSIS 주기코드: 반기 = H)
    startPrdDe: prdDe,
    endPrdDe: prdDe,
    format: "json",
    apiKey: KOSIS_API_KEY, // ← URL에만 실으며 절대 로그/응답에 노출하지 않음
  });

  const res = await httpsGet(KOSIS_ENDPOINT + "&" + params.toString());
  if (res.status !== 200) {
    const err = new Error("KOSIS API가 HTTP " + res.status + "를 반환했습니다.");
    err.status = 502;
    throw err;
  }

  let rows;
  try {
    rows = lenientJsonParse(res.body);
  } catch {
    const err = new Error("KOSIS 응답을 파싱할 수 없습니다.");
    err.status = 502;
    throw err;
  }

  // KOSIS 오류 응답: {err:"20", errMsg:"..."} (배열 아님)
  if (!Array.isArray(rows)) {
    // 업스트림이 키를 메시지에 포함해 돌려줄 가능성에 대비해 제거 후 사용
    const raw = String(rows.errMsg || rows.err || "알 수 없는 오류");
    const msg = raw.split(KOSIS_API_KEY).join("***").split(encodeURIComponent(KOSIS_API_KEY)).join("***");
    const err = new Error("KOSIS API 오류: " + msg);
    // 해당 시점에 자료가 없는 경우는 클라이언트 잘못된 요청이 아니라 "없음"으로 알려준다
    err.status = /존재하지 않습니다|없습니다/.test(msg) ? 404 : 502;
    err.expose = err.status === 404; // 자료 없음 안내는 사용자에게 유용하므로 전달
    throw err;
  }

  // (year, half) 시점 데이터만 남긴다 (objL2=ALL이 다른 시점을 섞지 않지만 방어적으로)
  const wanted = String(year) + (half === 2 ? "02" : "01");
  const periodRows = rows.filter((r) => String(r.PRD_DE) === wanted);
  if (periodRows.length === 0) {
    const err = new Error("해당 시점(" + wanted + ")의 데이터가 KOSIS에 없습니다.");
    err.status = 404;
    throw err;
  }

  // {연령코드: {employed, rate}} 로 재구성
  const byAge = {};
  let tblName = "";
  for (const r of periodRows) {
    tblName = r.TBL_NM || tblName;
    const entry = (byAge[r.C2] = byAge[r.C2] || {});
    if (r.ITM_ID === ITEM_EMPLOYED) entry.employed = Number(r.DT);
    if (r.ITM_ID === ITEM_RATE) entry.rate = Number(r.DT);
  }

  const ages = Object.entries(AGE_CODES).map(([key, def]) => {
    const v = byAge[def.code] || {};
    return {
      key,
      label: def.label,
      employedThousands: Number.isFinite(v.employed) ? v.employed : null,
      ratePercent: Number.isFinite(v.rate) ? v.rate : null,
    };
  });

  return {
    source: "KOSIS 국가통계포털 (온라인 API 실시간 조회)",
    region: { code: "3402", name: "공주시" },
    table: { id: KOSIS_PARAMS.tblId, name: tblName },
    period: `${year}년 ${half === 2 ? "하" : "상"}반기`,
    ages,
  };
}

/* ---------------- 라우팅 ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// 업스트림 오류를 클라이언트 응답으로 변환 (키 노출 없음)
function errorResponse(err) {
  const status = err.status || 500;
  // expose=true이면 사용자 조치 가능한 메시지 그대로, 아니면 API별 일반 메시지
  const message = err.expose
    ? maskSecret(err.message)
    : "데이터 조회에 실패했습니다. 잠시 후 다시 시도해주세요.";
  return { status, body: { error: true, message, code: err.status || 500 } };
}

async function handleApi(req, res, pathname, query) {
  // GET /api/kosis/employment/gongju?year=2026&half=1
  if (pathname === "/api/kosis/employment/gongju") {
    const year = parseInt(query.get("year"), 10);
    const half = parseInt(query.get("half"), 10) === 2 ? 2 : 1;

    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return sendJson(res, 400, {
        error: true,
        message: "year 파라미터는 2000~2100 사이의 연도여야 합니다. (예: year=2026)",
      });
    }
    if (query.get("half") !== null && ![1, 2].includes(half)) {
      return sendJson(res, 400, {
        error: true,
        message: "half 파라미터는 1(상반기) 또는 2(하반기)여야 합니다.",
      });
    }

    try {
      const data = await fetchGongjuEmployment(year, half);
      return sendJson(res, 200, data);
    } catch (err) {
      // 로그에는 키 대신 사유만 기록
      console.error(`[kosis] /employment/gongju 실패 (year=${year}, half=${half}):`, maskSecret(err.message));
      const e = errorResponse(err);
      return sendJson(res, e.status, e.body);
    }
  }

  // GET /api/volunteer?pageNo=1 — 공주시 봉사활동 목록
  if (pathname === "/api/volunteer") {
    const pageNo = parseInt(query.get("pageNo"), 10) || 1;
    try {
      const data = await fetchVolunteerList(pageNo);
      return sendJson(res, 200, data);
    } catch (err) {
      console.error(`[volunteer] 목록 조회 실패 (pageNo=${pageNo}):`, maskSecret(err.message));
      const e = errorResponse(err);
      return sendJson(res, e.status, e.body);
    }
  }

  // GET /api/volunteer/:programId — 봉사활동 상세
  const volDetailMatch = pathname.match(/^\/api\/volunteer\/(\d+)$/);
  if (volDetailMatch) {
    const programId = volDetailMatch[1];
    try {
      const data = await fetchVolunteerDetail(programId);
      return sendJson(res, 200, data);
    } catch (err) {
      console.error(`[volunteer] 상세 조회 실패 (id=${programId}):`, maskSecret(err.message));
      const e = errorResponse(err);
      return sendJson(res, e.status, e.body);
    }
  }

  // /api/volunteer/* 인데 숫자가 아닌 경우
  if (pathname.startsWith("/api/volunteer/")) {
    return sendJson(res, 400, {
      error: true,
      message: "programId는 숫자 등록번호여야 합니다. (예: /api/volunteer/2988739)",
    });
  }

  return sendJson(res, 404, { error: true, message: "찾을 수 없는 API 경로입니다." });
}

/* ---------------- 정적 파일 ---------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname);
  let file = path.normalize(path.join(STATIC_DIR, rel === "/" ? "index.html" : rel));
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not Found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

/* ---------------- 서버 ---------------- */

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = u.pathname;

  // CORS — 정상/오류 응답 모두에 적용되도록 라우팅 분기 전에 설정
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (pathname.startsWith("/api/")) {
      if (req.method !== "GET") {
        return sendJson(res, 405, { error: true, message: "GET 요청만 지원합니다." });
      }
      return await handleApi(req, res, pathname, u.searchParams);
    }
    return serveStatic(res, pathname);
  } catch (err) {
    console.error("[server] 처리 오류:", err.message);
    return sendJson(res, 500, { error: true, message: "서버 내부 오류가 발생했습니다." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`공주 일자리 서버 시작: http://${HOST}:${PORT}`);
  console.log(`  KOSIS_API_KEY: ${KOSIS_API_KEY ? "설정됨" : "없음 (.env에 KOSIS_API_KEY 필요)"}`);
  console.log(`  VOLUNTEER_SERVICE_KEY: ${VOLUNTEER_SERVICE_KEY ? "설정됨" : "없음 (.env에 VOLUNTEER_SERVICE_KEY 필요)"}`);
  console.log(`  API: GET /api/kosis/employment/gongju?year=2026&half=1`);
  console.log(`       GET /api/volunteer?pageNo=1`);
  console.log(`       GET /api/volunteer/{등록번호}`);
});
