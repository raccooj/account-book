import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "NEXT_PUBLIC_SUPABASE_URL과 NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY를 .env.local에 설정해 주세요.",
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);

export type Expense = {
  id: string;
  created_at: string;
  date: string;
  amount: number;
  description: string;
};
