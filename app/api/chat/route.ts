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

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
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

/** Monday = 0 … Sunday = 6 */
function getMondayOffset(base = getKstDateParts()) {
  const jsDay = toUtcDate(base).getUTCDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function getWeekDates(weekOffset: number, base = getKstDateParts()) {
  const monday = toUtcDate(base);
  monday.setUTCDate(monday.getUTCDate() - getMondayOffset(base) + weekOffset * 7);

  const labels = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ] as const;

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
    .map((n) => `- "${n} days ago" / "${n} day${n === 1 ? "" : "s"} ago" → ${shiftDate(-n, todayParts)}`)
    .join("\n");

  const thisWeekLines = thisWeek
    .map((d) => `  - this week ${d.label} → ${d.date}`)
    .join("\n");
  const lastWeekLines = lastWeek
    .map((d) => `  - last week ${d.label} → ${d.date}`)
    .join("\n");

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
    guide: `Relative date conversion table (always use this table):
- "today" → ${today}
- "yesterday" → ${shiftDate(-1, todayParts)}
- "the day before yesterday" → ${shiftDate(-2, todayParts)}
${daysAgoLines}
- "a week ago" / "1 week ago" → ${shiftDate(-7, todayParts)}
- "2 weeks ago" → ${shiftDate(-14, todayParts)}
- this week (${thisWeek[0].date} ~ ${thisWeek[6].date}):
${thisWeekLines}
- last week (${lastWeek[0].date} ~ ${lastWeek[6].date}):
${lastWeekLines}
- this month: ${thisMonthStart} ~ ${thisMonthEnd}
- last month: ${lastMonthStart} ~ ${lastMonthEnd}

Ambiguous dates (expense logging only):
- If the user says only "last week" without a weekday, set expense=null and ask which day.
- If the user says only "this week" without a weekday, ask which day.`,
  };
}

/** Strong question words → query; amount included → expense (questions win) */
function classifyIntent(message: string): Intent {
  const normalized = message.replace(/\s+/g, " ").trim().toLowerCase();

  const strongQuestionPatterns = [
    /\bhow much\b/,
    /\bhow many\b/,
    /\bwhat\b/,
    /\bwhich\b/,
    /\bwhen\b/,
    /\bwhere\b/,
    /\btotal\b/,
    /\bsum\b/,
    /\bspent\b/,
    /\bspending\b/,
    /\bmost\b/,
    /\btop expense\b/,
    /\bstatistics\b/,
    /\bstats\b/,
    /\banalyze\b/,
    /\btell me\b/,
    /\bshow me\b/,
    /\bdid i\b/,
    /\bdo i\b/,
    /얼마/,
    /얼마나/,
    /뭐\s*샀/,
    /무엇을/,
    /어떻게/,
    /총\s*지출/,
    /가장\s*많이/,
    /\?/,
  ];

  if (strongQuestionPatterns.some((pattern) => pattern.test(normalized))) {
    return "query";
  }

  const hasAmount =
    /\$\s*\d/.test(normalized) ||
    /\d[\d,]*(?:\.\d+)?\s*(?:krw|won|원|만원|천원|dollars?|usd)/i.test(message) ||
    /\d[\d,]*만\b/.test(message) ||
    /\d[\d,]*천\b/.test(message) ||
    /\b\d[\d,]{2,}\b/.test(normalized);

  if (hasAmount) {
    return "expense";
  }

  if (
    /\bexpenses?\b|\bhistory\b|\blist\b|\brecords?\b|\bpurchases?\b/.test(normalized) ||
    /지출|내역|목록|기록/.test(message)
  ) {
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
  const monthName = MONTH_NAMES[month - 1];
  const dateLabel =
    year === currentYear ? `${monthName} ${day}` : `${monthName} ${day}, ${year}`;

  return `Saved ${expense.description} for ${expense.amount.toLocaleString("en-US")} KRW on ${dateLabel}!`;
}

function formatHistory(history: ChatMessage[]) {
  return history
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`)
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
    : new Error("Gemini API request failed.");
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
    const detail = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: `Couldn't load expense data.\n(${detail})` },
      { status: 500 },
    );
  }

  const expenseLines =
    expenses.length === 0
      ? "(no saved expenses)"
      : expenses
          .map(
            (item, index) =>
              `${index + 1}. date=${item.date}, amount=${item.amount}, description=${item.description}`,
          )
          .join("\n");

  const prompt = `You are a friendly English-speaking expense stats chatbot.
Answer the user's question using ONLY the expense data below.
Do not invent data that is not present.
Always reply in natural, friendly English.

Today's date (Korea time): ${relative.today}

${relative.guide}

Period tips:
- this month → ${relative.thisMonthStart} ~ ${relative.thisMonthEnd} (or until today)
- last month → ${relative.lastMonthStart} ~ ${relative.lastMonthEnd}
- this week → ${relative.thisWeekStart} ~ ${relative.thisWeekEnd}
- last week → ${relative.lastWeekStart} ~ ${relative.lastWeekEnd}
- yesterday → ${relative.yesterday}
- Group food/meals/lunch/dinner/coffee/cafe by description keywords.
- "Top expense" means the description with the highest total amount.
- Format amounts with thousands separators and mention KRW.

Expense data (${expenses.length} items):
${expenseLines}

Previous conversation:
${formatHistory(history) || "(none)"}

User question: ${message}

Output JSON only:
{"reply":"friendly English answer","expense":null}

If there is no data, say so honestly.`;

  let text: string;
  try {
    text = await generateWithFallback(apiKey, prompt);
  } catch {
    return NextResponse.json(
      {
        error: "The AI server is busy right now. Please try again in a few seconds.",
      },
      { status: 503 },
    );
  }

  const parsed = extractJson(text);
  if (!parsed?.reply?.trim()) {
    return NextResponse.json(
      {
        error: "I couldn't understand the AI response. Please rephrase your question.",
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

  const systemPrompt = `You are a friendly English-speaking expense chatbot.
Extract expense details from the user message and respond with JSON only.
This is an expense logging request, not a stats question.
Always write the reply field in English.

Today's date (Korea time): ${relative.today}

${relative.guide}

Extraction rules:
1. date: must be YYYY-MM-DD. Prefer the conversion table above.
   - Keep explicit dates as-is (e.g. 2026-04-01)
   - If no date is mentioned, use ${relative.today}
2. amount: integer. "20,000 won"=20000, "$15"=15, "8k"=8000.
3. description: short expense label (e.g. taxi, lunch, coffee).
4. If date or amount is unclear, set expense=null and ask for the missing info in reply.

JSON format only:
{"reply":"English message for the user","expense":{"date":"YYYY-MM-DD","amount":20000,"description":"taxi"}}
or when info is missing:
{"reply":"Which day last week was that?","expense":null}`;

  const prompt = `${systemPrompt}

Previous conversation:
${formatHistory(history) || "(none)"}

User: ${message}

Output JSON that follows the rules above.`;

  let text: string;
  try {
    text = await generateWithFallback(apiKey, prompt);
  } catch {
    return NextResponse.json(
      {
        error: "The AI server is busy right now. Please try again in a few seconds.",
      },
      { status: 503 },
    );
  }

  const parsed = extractJson(text);

  if (!parsed || typeof parsed.reply !== "string" || !parsed.reply.trim()) {
    return NextResponse.json(
      {
        error: "I couldn't understand the AI response. Please be a bit more specific.",
      },
      { status: 502 },
    );
  }

  if (!isValidExpense(parsed.expense)) {
    return NextResponse.json({
      reply:
        parsed.reply ||
        "I couldn't tell the date or amount. Example: lunch 15000 today",
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
        error: `Couldn't save the expense. Please try again.\n(${error.message})`,
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
            "GEMINI_API_KEY is not set. Please check your .env.local file.",
        },
        { status: 500 },
      );
    }

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { error: "Supabase environment variables are not set." },
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
        { error: "Please enter a message." },
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
      error instanceof Error ? error.message : "An unknown error occurred.";
    return NextResponse.json(
      {
        error: `Something went wrong. Please try again.\n(${detail})`,
      },
      { status: 500 },
    );
  }
}
