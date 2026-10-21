import { redirect } from "next/navigation";
import { currentUser, homeFor } from "./session";

export default async function Home() {
  const user = await currentUser();
  redirect(user === undefined ? "/login" : homeFor(user));
}
