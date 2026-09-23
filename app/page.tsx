"use client";

import { FormEvent, useEffect, useState } from "react";
import { type Expense, supabase } from "@/lib/supabase";

function formatAmount(value: number) {
  return value.toLocaleString("ko-KR");
}

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

const fieldClassName =
  "h-14 w-full min-h-[3.5rem] touch-manipulation rounded-xl bg-white px-4 text-lg text-foreground outline-none transition placeholder:text-muted/70 focus:bg-white focus:ring-2 focus:ring-accent/25 sm:h-12 sm:min-h-0 sm:text-base";

export default function Home() {
  const [date, setDate] = useState(todayString);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadExpenses() {
      setLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from("expenses")
        .select("*")
        .order("created_at", { ascending: false });

      if (fetchError) {
        setError(fetchError.message);
        setExpenses([]);
      } else {
        setExpenses(data ?? []);
      }

      setLoading(false);
    }

    void loadExpenses();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const parsedAmount = Number(amount.replace(/,/g, ""));
    if (!date || !description.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return;
    }

    setSaving(true);
    setError(null);

    const { data, error: insertError } = await supabase
      .from("expenses")
      .insert({
        date,
        amount: parsedAmount,
        description: description.trim(),
      })
      .select()
      .single();

    if (insertError) {
      setError(insertError.message);
      setSaving(false);
      return;
    }

    if (data) {
      setExpenses((prev) => [data, ...prev]);
    }

    setAmount("");
    setDescription("");
    setDate(todayString());
    setSaving(false);
  }

  const total = expenses.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="min-h-full bg-background">
      <main className="mx-auto flex w-full max-w-xl flex-col gap-14 px-5 py-12 sm:gap-16 sm:px-8 sm:py-20">
        <header className="flex flex-col gap-3">
          <h1 className="text-[2rem] font-semibold tracking-tight text-foreground sm:text-[2.5rem]">
            나의 스마트 가계부
          </h1>
          <p className="text-lg text-muted sm:text-base">
            날짜, 금액, 내용을 입력하고 지출을 기록하세요.
          </p>
        </header>

        <form
          onSubmit={handleSubmit}
          className="flex w-full flex-col gap-8 rounded-2xl bg-surface p-6 sm:gap-6 sm:p-8"
        >
          <div className="flex flex-col gap-2.5 sm:gap-2">
            <label
              htmlFor="date"
              className="text-base font-medium text-foreground/80 sm:text-sm"
            >
              날짜
            </label>
            <input
              id="date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              required
              className={fieldClassName}
            />
          </div>

          <div className="flex flex-col gap-2.5 sm:gap-2">
            <label
              htmlFor="amount"
              className="text-base font-medium text-foreground/80 sm:text-sm"
            >
              금액
            </label>
            <div className="relative">
              <input
                id="amount"
                type="number"
                inputMode="numeric"
                min="1"
                step="1"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
                className={`${fieldClassName} font-amount pr-14`}
              />
              <span className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2 text-base text-muted sm:text-sm">
                원
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 sm:gap-2">
            <label
              htmlFor="description"
              className="text-base font-medium text-foreground/80 sm:text-sm"
            >
              내용
            </label>
            <input
              id="description"
              type="text"
              placeholder="예: 점심 식사, 교통비"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              className={fieldClassName}
            />
          </div>

          {error && (
            <p className="text-base text-red-600 sm:text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={saving}
            className="mt-1 min-h-[3.75rem] touch-manipulation rounded-xl bg-accent text-lg font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 sm:mt-2 sm:h-12 sm:min-h-0 sm:text-base"
          >
            {saving ? "저장 중..." : "저장하기"}
          </button>
        </form>

        <section className="flex w-full flex-col gap-8">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-lg">
              지출 내역
            </h2>
            <p className="text-base text-muted sm:text-sm">
              합계{" "}
              <span className="font-amount text-xl font-medium text-accent sm:text-lg">
                {formatAmount(total)}
              </span>
              <span className="ml-0.5 text-muted">원</span>
            </p>
          </div>

          {loading ? (
            <p className="py-12 text-center text-base text-muted sm:text-sm">
              불러오는 중...
            </p>
          ) : expenses.length === 0 ? (
            <p className="py-12 text-center text-base text-muted sm:text-sm">
              아직 저장된 지출이 없습니다.
            </p>
          ) : (
            <ul className="flex w-full flex-col gap-3">
              {expenses.map((expense) => (
                <li
                  key={expense.id}
                  className="flex min-h-[4.75rem] items-center justify-between gap-5 rounded-2xl bg-surface px-5 py-5 sm:min-h-0 sm:px-6 sm:py-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg font-medium text-foreground sm:text-base">
                      {expense.description}
                    </p>
                    <p className="mt-1.5 text-base text-muted sm:text-sm">
                      {expense.date}
                    </p>
                  </div>
                  <p className="font-amount shrink-0 text-xl font-medium text-foreground sm:text-lg">
                    -{formatAmount(expense.amount)}
                    <span className="ml-0.5 text-base font-sans font-normal text-muted sm:text-sm">
                      원
                    </span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
