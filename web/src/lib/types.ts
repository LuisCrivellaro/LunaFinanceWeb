export type Kind = "income" | "expense";

export interface Me {
  id: number;
  name: string;
  email: string;
  color: string;
  familyAccess: "none" | "summary" | "full";
  notifyDueDays: number;
  notifyOverdue: boolean;
  notifyDaily: boolean;
  notifyWeekly: boolean;
  notifyGoals: boolean;
  notifyAnomaly: boolean;
  /** Final (4 dígitos) do cartão de crédito; null = não cadastrado. */
  cardLast4: string | null;
  telegramUsername: string | null;
  telegramLinkedAt: string | null;
  capabilities: { manageMembers: boolean };
}

export interface Member {
  id: number;
  name: string;
  color: string;
  telegramLinked: boolean;
}

export interface Category {
  id: number;
  name: string;
  kind: Kind;
  icon: string;
  color: string;
  keywords: string;
  isDefault: boolean;
  createdBy: number | null;
  archived: boolean;
}

export interface Account {
  id: number;
  ownerId: number;
  name: string;
  type: string;
  initialBalanceCents: number;
  isDefault: boolean;
  archived: boolean;
  balanceCents: number;
}

export interface Transaction {
  id: number;
  userId: number;
  accountId: number;
  accountName: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  kind: Kind;
  amountCents: number;
  description: string;
  date: string;
  status: "paid" | "pending";
  paidAt: string | null;
  nature: "fixed" | "variable";
  notes: string | null;
  recurrenceId: number | null;
  installmentGroup: string | null;
  installmentNumber: number | null;
  installmentTotal: number | null;
  source: string;
  paymentMethod: PaymentMethod | null;
  overdue: boolean;
}

export type PaymentMethod = "pix" | "credit_card" | "debit_card" | "cash" | "boleto" | "transfer" | "other";
export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  pix: "Pix",
  credit_card: "Cartão de crédito",
  debit_card: "Cartão de débito",
  cash: "Dinheiro",
  boleto: "Boleto",
  transfer: "Transferência",
  other: "Outro",
};

export interface Goal {
  id: number;
  scope: "individual" | "family";
  ownerId: number;
  name: string;
  targetCents: number;
  savedCents: number;
  deadline: string | null;
  color: string;
  icon: string;
  archived: boolean;
  achievedAt: string | null;
  percent: number;
  monthlyNeededCents: number | null;
  contributors: Array<{ userId: number; cents: number }>;
}

export interface MonthTotals {
  incomePaidCents: number;
  incomeTotalCents: number;
  expensePaidCents: number;
  expenseTotalCents: number;
}

export interface CategorySlice {
  categoryId: number | null;
  name: string;
  color: string;
  icon: string;
  cents: number;
  count: number;
  percent: number;
}

export interface SeriesPoint {
  month: string;
  incomeCents: number;
  expenseCents: number;
  resultCents: number;
}

export interface Dashboard {
  month: string;
  view: "me" | "family" | number;
  detail: boolean;
  balanceCents: number;
  totals: MonthTotals;
  previousTotals: MonthTotals;
  resultCents: number;
  resultPaidCents: number;
  series: SeriesPoint[];
  balanceHistory: Array<{ month: string; balanceCents: number }>;
  expensesByCategory: CategorySlice[];
  upcoming: { items: Transaction[]; count: number; totalCents: number };
  overdue: { items: Transaction[]; count: number; totalCents: number };
  goals: Goal[];
  members: Array<{ userId: number; name: string; color: string; balanceCents: number } & MonthTotals> | null;
  accounts: Account[];
}

export interface Report {
  period: string;
  from: string;
  to: string;
  detail: boolean;
  totals: {
    incomeCents: number;
    expenseCents: number;
    resultCents: number;
    savingsRate: number | null;
    avgMonthlyExpenseCents: number;
    fixedExpenseCents: number;
    variableExpenseCents: number;
  };
  series: SeriesPoint[];
  expensesByCategory: CategorySlice[];
  incomeByCategory: CategorySlice[];
  byMember: Array<{ userId: number; incomeCents: number; expenseCents: number }> | null;
  topExpenses: Transaction[];
}

export interface Recurrence {
  id: number;
  userId: number;
  kind: Kind;
  amountCents: number;
  description: string;
  nature: string;
  dayOfMonth: number;
  startDate: string;
  endDate: string | null;
  autoPaid: boolean;
  active: boolean;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  accountName: string;
}

export type View = "me" | "family" | number;
