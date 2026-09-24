import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ExpensePayload = {
  date: string;
  amount: number;
  description: string;
};

type ExpenseRow = ExpensePayload & {
  id: string;
  created_at: string;
};

type GeminiResult = {
  reply: string;
  expense: ExpensePayload | null;
};

type Intent = "query" | "expense";

const GEMINI_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3-flash-preview",
  "gemini-flash-latest",
] as const;

function getKstDateParts(base = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(base);

  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);

  return { year, month, day };
}

function formatDate(year: number, month: number, day: number) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toUtcDate({ year, month, day }: { year: number; month: number; day: number }) {
  return new Date(Date.UTC(year, month - 1, day));
}

function shiftDate(days: number, base = getKstDateParts()) {
  const date = toUtcDate(base);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** 월요일=0 … 일요일=6 (한국식 주 시작: 월요일) */
function getMondayOffset(base = getKstDateParts()) {
  const jsDay = toUtcDate(base).getUTCDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function getWeekDates(weekOffset: number, base = getKstDateParts()) {
  const monday = toUtcDate(base);
  monday.setUTCDate(monday.getUTCDate() - getMondayOffset(base) + weekOffset * 7);

  const labels = ["월요일", "화요일", "수요일", "목요일", "금요일", "토요일", "일요일"] as const;
  return labels.map((label, index) => {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    return {
      label,
      date: formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()),
    };
  });
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildRelativeDateGuide(todayParts = getKstDateParts()) {
  const today = formatDate(todayParts.year, todayParts.month, todayParts.day);
  const thisWeek = getWeekDates(0, todayParts);
  const lastWeek = getWeekDates(-1, todayParts);
  const thisMonthStart = formatDate(todayParts.year, todayParts.month, 1);
  const thisMonthEnd = formatDate(
    todayParts.year,
    todayParts.month,
    daysInMonth(todayParts.year, todayParts.month),
  );

  const prevMonth =
    todayParts.month === 1
      ? { year: todayParts.year - 1, month: 12 }
      : { year: todayParts.year, month: todayParts.month - 1 };
  const lastMonthStart = formatDate(prevMonth.year, prevMonth.month, 1);
  const lastMonthEnd = formatDate(
    prevMonth.year,
    prevMonth.month,
    daysInMonth(prevMonth.year, prevMonth.month),
  );

  const daysAgoLines = [1, 2, 3, 4, 5, 6, 7, 10, 14]
    .map((n) => `- "${n}일 전" / "${n}일전" → ${shiftDate(-n, todayParts)}`)
    .join("\n");

  const thisWeekLines = thisWeek.map((d) => `  - 이번주 ${d.label} → ${d.date}`).join("\n");
  const lastWeekLines = lastWeek.map((d) => `  - 지난주 ${d.label} → ${d.date}`).join("\n");

  return {
    today,
    yesterday: shiftDate(-1, todayParts),
    thisWeekStart: thisWeek[0].date,
    thisWeekEnd: thisWeek[6].date,
    lastWeekStart: lastWeek[0].date,
    lastWeekEnd: lastWeek[6].date,
    thisMonthStart,
    thisMonthEnd,
    lastMonthStart,
    lastMonthEnd,
    guide: `상대 날짜 변환표 (반드시 이 표 기준으로 계산하세요):
- "오늘" → ${today}
- "어제" → ${shiftDate(-1, todayParts)}
- "그저께" / "그제" → ${shiftDate(-2, todayParts)}
${daysAgoLines}
- "일주일 전" / "1주일 전" / "한 주 전" → ${shiftDate(-7, todayParts)}
- "이주 전" / "2주 전" → ${shiftDate(-14, todayParts)}
- 이번주 (${thisWeek[0].date} ~ ${thisWeek[6].date}):
${thisWeekLines}
- 지난주 (${lastWeek[0].date} ~ ${lastWeek[6].date}):
${lastWeekLines}
- 이번달: ${thisMonthStart} ~ ${thisMonthEnd}
- 지난달: ${lastMonthStart} ~ ${lastMonthEnd}

모호한 날짜 처리(지출 입력일 때만):
- "지난주"만 있고 요일이 없으면 expense=null, 요일을 물어보세요.
- "이번주"만 있고 요일이 없으면 요일을 물어보세요.
- "저번주"는 "지난주"와 동일하게 처리하세요.`,
  };
}

/** 의문사/통계 질문 → query, 금액 포함 기록 → expense (강한 질문이 우선) */
function classifyIntent(message: string): Intent {
  const normalized = message.replace(/\s+/g, " ").trim();

  const strongQuestionPatterns = [
    /얼마/,
    /얼마나/,
    /뭐\s*샀/,
    /뭐\s*샀더라/,
    /무엇을/,
    /뭐야/,
    /뭐지/,
    /어떻게/,
    /어디서/,
    /언제/,
    /어떤\s*항목/,
    /총\s*지출/,
    /총액/,
    /합계/,
    /가장\s*많이/,
    /제일\s*많이/,
    /통계/,
    /분석/,
    /알려줘/,
    /알려\s*줄래/,
    /궁금/,
    /몇\s*건/,
    /얼마나\s*썼/,
    /\?/,
  ];

  if (strongQuestionPatterns.some((pattern) => pattern.test(normalized))) {
    return "query";
  }

  const hasAmount =
    /\d[\d,]*(?:\.\d+)?\s*(?:원|만원|천원|억)/.test(normalized) ||
    /\d[\d,]*만\b/.test(normalized) ||
    /\d[\d,]*천\b/.test(normalized) ||
    /(?:만원|천원)/.test(normalized);

  if (hasAmount) {
    return "expense";
  }

  if (/지출|내역|목록|기록|소비|사용\s*내역|뭐\s*샀/.test(normalized)) {
    return "query";
  }

  return "expense";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableGeminiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("[503") ||
    message.includes("[429") ||
    message.includes("high demand") ||
    message.includes("Resource exhausted") ||
    message.includes("try again later")
  );
}

function extractJson(text: string): GeminiResult | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();

  try {
    return JSON.parse(raw) as GeminiResult;
  } catch {
    const objectMatch = raw.match(/\{[\s\S]*\}/);
    if (!objectMatch) return null;
    try {
      return JSON.parse(objectMatch[0]) as GeminiResult;
    } catch {
      return null;
    }
  }
}

function isValidExpense(expense: ExpensePayload | null | undefined): expense is ExpensePayload {
  if (!expense) return false;
  if (typeof expense.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(expense.date)) {
    return false;
  }
  if (typeof expense.description !== "string" || !expense.description.trim()) {
    return false;
  }
  const amount = Number(expense.amount);
  return Number.isFinite(amount) && amount > 0;
}

function buildConfirmReply(expense: ExpensePayload) {
  const [year, month, day] = expense.date.split("-").map(Number);
  const currentYear = getKstDateParts().year;
  const dateLabel =
    year === currentYear
      ? `${month}월 ${day}일`
      : `${year}년 ${month}월 ${day}일`;

  return `${dateLabel} ${expense.description} ${expense.amount.toLocaleString("ko-KR")}원을 저장했어요!`;
}

function formatHistory(history: ChatMessage[]) {
  return history
    .map((item) => `${item.role === "user" ? "사용자" : "챗봇"}: ${item.content}`)
    .join("\n");
}

async function generateWithFallback(apiKey: string, prompt: string) {
  const genAI = new GoogleGenerativeAI(apiKey);
  let lastError: unknown;

  for (const modelName of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        });
        const result = await model.generateContent(prompt);
        return result.response.text();
      } catch (error) {
        lastError = error;
        if (isRetryableGeminiError(error) && attempt < 2) {
          await sleep(800 * attempt);
          continue;
        }
        if (isRetryableGeminiError(error)) {
          break;
        }
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Gemini API 호출에 실패했습니다.");
}

async function fetchAllExpenses(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("expenses")
    .select("*")
    .order("date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as ExpenseRow[];
}

async function handleQuery(params: {
  apiKey: string;
  supabase: SupabaseClient;
  message: string;
  history: ChatMessage[];
}) {
  const { apiKey, supabase, message, history } = params;
  const relative = buildRelativeDateGuide();

  let expenses: ExpenseRow[];
  try {
    expenses = await fetchAllExpenses(supabase);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: `지출 데이터를 불러오지 못했어요.\n(${detail})` },
      { status: 500 },
    );
  }

  const expenseLines =
    expenses.length === 0
      ? "(저장된 지출 없음)"
      : expenses
          .map(
            (item, index) =>
              `${index + 1}. date=${item.date}, amount=${item.amount}, description=${item.description}`,
          )
          .join("\n");

  const prompt = `당신은 친절한 한국어 가계부 통계 챗봇입니다.
사용자의 질문에 대해 아래 지출 데이터만 근거로 자연스럽고 친근하게 답하세요.
추측으로 없는 데이터를 만들지 마세요.

오늘 날짜(한국 시간): ${relative.today}

${relative.guide}

기간 해석 팁:
- 이번달 → ${relative.thisMonthStart} ~ ${relative.thisMonthEnd} (또는 오늘까지)
- 지난달 → ${relative.lastMonthStart} ~ ${relative.lastMonthEnd}
- 이번주 → ${relative.thisWeekStart} ~ ${relative.thisWeekEnd}
- 지난주 → ${relative.lastWeekStart} ~ ${relative.lastWeekEnd}
- 어제 → ${relative.yesterday}
- 식비/밥/점심/저녁/커피/카페 등은 description 키워드로 묶어 계산하세요.
- 가장 많이 쓴 항목은 description 기준 합계가 가장 큰 항목입니다.
- 금액은 천 단위 쉼표를 넣어 읽기 쉽게 말해 주세요.

지출 데이터 (총 ${expenses.length}건):
${expenseLines}

이전 대화:
${formatHistory(history) || "(없음)"}

사용자 질문: ${message}

반드시 JSON만 출력:
{"reply":"친절한 한국어 답변","expense":null}

데이터가 없으면 없다고 솔직히 말하세요.`;

  let text: string;
  try {
    text = await generateWithFallback(apiKey, prompt);
  } catch {
    return NextResponse.json(
      {
        error: "지금 AI 서버가 일시적으로 혼잡해요. 몇 초 뒤 다시 전송해 주세요.",
      },
      { status: 503 },
    );
  }

  const parsed = extractJson(text);
  if (!parsed?.reply?.trim()) {
    return NextResponse.json(
      {
        error: "AI 응답을 이해하지 못했어요. 질문을 조금 바꿔서 다시 물어봐 주세요.",
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    reply: parsed.reply.trim(),
    expense: null,
  });
}

async function handleExpense(params: {
  apiKey: string;
  supabase: SupabaseClient;
  message: string;
  history: ChatMessage[];
}) {
  const { apiKey, supabase, message, history } = params;
  const todayParts = getKstDateParts();
  const relative = buildRelativeDateGuide(todayParts);

  const systemPrompt = `당신은 친절한 한국어 가계부 챗봇입니다.
사용자 메시지에서 지출 정보를 추출해 JSON으로만 응답하세요.
통계/조회 질문이 아니라 지출 기록 요청입니다.

오늘 날짜(한국 시간): ${relative.today}

${relative.guide}

추출 규칙:
1. date: 반드시 YYYY-MM-DD. 위 변환표를 우선 사용하세요.
   - 구체적 날짜면 그대로 (예: 2026-04-01)
   - 날짜 언급이 전혀 없으면 ${relative.today}
2. amount: 정수(원). "2만원"=20000, "1.5만"=15000, "8천"=8000.
3. description: 짧은 지출 내용 (예: 택시, 점심, 커피).
4. 날짜·금액이 모호하면 expense=null로 두고 reply로 부족한 정보를 물어보세요.

응답 JSON 형식만 사용:
{"reply":"사용자에게 보여줄 한국어 문장","expense":{"date":"YYYY-MM-DD","amount":20000,"description":"택시"}}
또는 정보가 부족할 때:
{"reply":"지난주 무슨 요일인지 알려주세요!","expense":null}`;

  const prompt = `${systemPrompt}

이전 대화:
${formatHistory(history) || "(없음)"}

사용자: ${message}

위 규칙에 맞는 JSON만 출력하세요.`;

  let text: string;
  try {
    text = await generateWithFallback(apiKey, prompt);
  } catch {
    return NextResponse.json(
      {
        error: "지금 AI 서버가 일시적으로 혼잡해요. 몇 초 뒤 다시 전송해 주세요.",
      },
      { status: 503 },
    );
  }

  const parsed = extractJson(text);

  if (!parsed || typeof parsed.reply !== "string" || !parsed.reply.trim()) {
    return NextResponse.json(
      {
        error: "AI 응답을 이해하지 못했어요. 조금 더 구체적으로 다시 말씀해 주세요.",
      },
      { status: 502 },
    );
  }

  if (!isValidExpense(parsed.expense)) {
    return NextResponse.json({
      reply:
        parsed.reply ||
        "날짜와 금액을 잘 이해하지 못했어요. 예: 오늘 점심 15000원",
      expense: null,
    });
  }

  const expensePayload: ExpensePayload = {
    date: parsed.expense.date,
    amount: Math.round(Number(parsed.expense.amount)),
    description: parsed.expense.description.trim(),
  };

  const { data, error } = await supabase
    .from("expenses")
    .insert({
      date: expensePayload.date,
      amount: expensePayload.amount,
      description: expensePayload.description,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json(
      {
        error: `지출 저장에 실패했어요. 잠시 후 다시 시도해 주세요.\n(${error.message})`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    reply: buildConfirmReply(expensePayload),
    expense: data,
  });
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    if (!apiKey) {
      return NextResponse.json(
        {
          error:
            "Gemini API 키가 설정되어 있지 않습니다. .env.local에 GEMINI_API_KEY를 확인해 주세요.",
        },
        { status: 500 },
      );
    }

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { error: "Supabase 환경 변수가 설정되어 있지 않습니다." },
        { status: 500 },
      );
    }

    const body = (await request.json()) as {
      message?: string;
      history?: ChatMessage[];
    };

    const message = body.message?.trim();
    if (!message) {
      return NextResponse.json(
        { error: "메시지를 입력해 주세요." },
        { status: 400 },
      );
    }

    const history = Array.isArray(body.history) ? body.history.slice(-12) : [];
    const supabase = createClient(supabaseUrl, supabaseKey);
    const intent = classifyIntent(message);

    if (intent === "query") {
      return handleQuery({ apiKey, supabase, message, history });
    }

    return handleExpense({ apiKey, supabase, message, history });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    return NextResponse.json(
      {
        error: `처리 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.\n(${detail})`,
      },
      { status: 500 },
    );
  }
}
