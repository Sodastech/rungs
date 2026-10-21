import { getDemo } from "../rungs/demo";
import { listExpenses } from "../rungs/expenses";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { db } = await getDemo();
  const expenses = await listExpenses(db);
  return <p>{expenses.length} expenses</p>;
}
