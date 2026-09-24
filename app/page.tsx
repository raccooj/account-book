"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { type Expense, supabase } from "@/lib/supabase";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

function formatAmount(value: number) {
  return value.toLocaleString("ko-KR");
}

export default function Home() {
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "안녕하세요! 지출 기록도, 통계 질문도 가능해요.\n예: 오늘 점심 8000원 / 이번달 총 지출이 얼마야? / 가장 많이 쓴 항목이 뭐야?",
    },
  ]);
  const [input, setInput] = useState("");
  const [loadingExpenses, setLoadingExpenses] = useState(true);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function loadExpenses() {
      setLoadingExpenses(true);
      const { data } = await supabase
        .from("expenses")
        .select("*")
        .order("created_at", { ascending: false });
      setExpenses(data ?? []);
      setLoadingExpenses(false);
    }

    void loadExpenses();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };

    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setSending(true);

    try {
      const history = nextMessages
        .filter((m) => m.id !== "welcome")
        .map(({ role, content }) => ({ role, content }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          history: history.slice(0, -1),
        }),
      });

      const data = (await response.json()) as {
        reply?: string;
        expense?: Expense | null;
        error?: string;
      };

      if (!response.ok || !data.reply) {
        throw new Error(data.error ?? "응답을 받지 못했습니다.");
      }

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.reply!,
        },
      ]);

      if (data.expense) {
        setExpenses((prev) => [data.expense!, ...prev]);
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "오류가 발생했습니다.";
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: `죄송해요. 처리 중 문제가 생겼어요.\n${message}`,
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-10 border-b border-black/5 bg-background/90 px-4 py-4 backdrop-blur-md sm:px-6">
        <div className="mx-auto w-full max-w-2xl">
          <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
            AI 가계부 챗봇
          </h1>
          <p className="mt-1 text-sm text-muted sm:text-base">
            대화로 지출을 기록하세요
          </p>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col overflow-hidden">
        <section className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-5">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium text-muted sm:text-base">
              저장된 지출
            </h2>
            {!loadingExpenses && expenses.length > 0 && (
              <p className="font-amount text-sm text-accent sm:text-base">
                {formatAmount(expenses.reduce((s, e) => s + e.amount, 0))}
                <span className="ml-0.5 font-sans text-muted">원</span>
              </p>
            )}
          </div>

          <div className="flex gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {loadingExpenses ? (
              <div className="w-full rounded-2xl bg-surface px-4 py-5 text-center text-sm text-muted">
                불러오는 중...
              </div>
            ) : expenses.length === 0 ? (
              <div className="w-full rounded-2xl bg-surface px-4 py-5 text-center text-sm text-muted">
                아직 저장된 지출이 없습니다
              </div>
            ) : (
              expenses.map((expense) => (
                <article
                  key={expense.id}
                  className="flex min-w-[11.5rem] max-w-[14rem] shrink-0 flex-col gap-1.5 rounded-2xl bg-surface px-4 py-3.5"
                >
                  <p className="truncate text-sm font-medium text-foreground sm:text-base">
                    {expense.description}
                  </p>
                  <p className="font-amount text-lg font-medium text-foreground">
                    -{formatAmount(expense.amount)}
                    <span className="ml-0.5 font-sans text-xs font-normal text-muted">
                      원
                    </span>
                  </p>
                  <p className="text-xs text-muted sm:text-sm">{expense.date}</p>
                </article>
              ))
            )}
          </div>
        </section>

        <section
          ref={chatContainerRef}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:gap-4 sm:px-6 sm:py-5"
        >
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-base leading-relaxed whitespace-pre-wrap sm:max-w-[75%] sm:text-[0.95rem] ${
                  message.role === "user"
                    ? "rounded-br-md bg-accent text-white"
                    : "rounded-bl-md bg-surface text-foreground"
                }`}
              >
                {message.content}
              </div>
            </div>
          ))}

          {sending && (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-md bg-surface px-4 py-3 text-sm text-muted">
                입력 중...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </section>

        <form
          onSubmit={handleSubmit}
          className="sticky bottom-0 shrink-0 border-t border-black/5 bg-background/95 px-3 py-3 backdrop-blur-md sm:px-6 sm:py-4"
        >
          <div className="flex items-end gap-2 sm:gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="지출 입력 또는 질문해 보세요"
              disabled={sending}
              className="min-h-12 flex-1 touch-manipulation rounded-2xl bg-surface px-4 py-3 text-base text-foreground outline-none transition placeholder:text-muted/70 focus:ring-2 focus:ring-accent/25 disabled:opacity-60 sm:min-h-11 sm:text-[0.95rem]"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="min-h-12 min-w-16 shrink-0 touch-manipulation rounded-2xl bg-accent px-4 text-base font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40 sm:min-h-11 sm:min-w-18"
            >
              전송
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
