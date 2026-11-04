/** Minimal native <dialog> prompts for T3 sign-in (wallet or email OTP). */

export type SignInMethod = "wallet" | "email";

/** Ask how to sign in to T3; resolves immediately when only one option applies. */
export function chooseSignIn(allowed: SignInMethod[], walletAvailable: boolean): Promise<SignInMethod> {
  const options = allowed.filter((m) => m !== "wallet" || walletAvailable);
  if (options.length === 0) return Promise.reject(new Error("no sign-in method available (install a browser wallet or enable email)"));
  if (options.length === 1) return Promise.resolve(options[0]!);
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "max-width:420px;width:calc(100% - 32px);border-radius:12px;border:1px solid #ccc;padding:20px;font:16px system-ui";
    const h = document.createElement("h3");
    h.textContent = "Sign in to T3 to seal";
    h.style.marginTop = "0";
    const p = document.createElement("p");
    p.textContent = "Your details are encrypted to your T3 enclave under this sign-in.";
    dialog.append(h, p);
    const labels: Record<SignInMethod, string> = { wallet: "Sign in with wallet", email: "Sign in with email" };
    for (const m of options) {
      const b = document.createElement("button");
      b.textContent = labels[m];
      b.dataset.method = m;
      b.style.cssText = "display:block;width:100%;margin:8px 0;padding:12px;font-size:16px";
      b.onclick = () => {
        dialog.remove();
        resolve(m);
      };
      dialog.append(b);
    }
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.style.cssText = "margin-top:8px;padding:10px 16px;font-size:16px";
    cancel.onclick = () => {
      dialog.remove();
      reject(new Error("sign-in cancelled"));
    };
    dialog.append(cancel);
    document.body.append(dialog);
    dialog.showModal();
  });
}
/** Where people create a Terminal 3 developer account (DID, API key, free test credits). */
export const SIGN_UP_URL = "https://terminal3.io/products/agent-developer-kit";

function ask(title: string, label: string, type: "email" | "text", autocomplete: AutoFill, note?: () => Node): Promise<string> {
  return new Promise((resolve, reject) => {
    const dialog = document.createElement("dialog");
    dialog.style.cssText = "max-width:420px;width:calc(100% - 32px);border-radius:12px;border:1px solid #ccc;padding:20px;font:16px system-ui";
    const form = document.createElement("form");
    form.method = "dialog";
    const h = document.createElement("h3");
    h.textContent = title;
    h.style.marginTop = "0";
    const l = document.createElement("label");
    l.textContent = label;
    l.style.display = "block";
    const input = document.createElement("input");
    input.type = type;
    input.required = true;
    input.autocomplete = autocomplete;
    input.style.cssText = "display:block;width:100%;margin:8px 0 16px;padding:10px;font-size:16px;box-sizing:border-box";
    if (type === "text") input.inputMode = "numeric";
    const ok = document.createElement("button");
    ok.textContent = "Continue";
    ok.value = "ok";
    ok.style.cssText = "padding:10px 16px;font-size:16px";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.value = "cancel";
    cancel.formNoValidate = true;
    cancel.style.cssText = "padding:10px 16px;font-size:16px;margin-left:8px";
    form.append(h, l, input, ok, cancel);
    if (note) form.append(note());
    dialog.append(form);
    document.body.append(dialog);
    dialog.addEventListener("close", () => {
      const value = input.value.trim();
      const confirmed = dialog.returnValue === "ok" && value;
      dialog.remove();
      if (confirmed) resolve(value);
      else reject(new Error("sign-in cancelled"));
    });
    dialog.showModal();
  });
}

/** A short paragraph with the sign-up link, shown under a sign-in field. */
function note(before: string, after: string): () => Node {
  return () => {
    const p = document.createElement("p");
    p.style.cssText = "margin:16px 0 0;font-size:14px;line-height:1.45";
    const a = document.createElement("a");
    a.href = SIGN_UP_URL;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Sign up free";
    p.append(before, a, after);
    return p;
  };
}

export const askEmail = () =>
  ask(
    "Sign in to your Terminal 3 account",
    "Your Terminal 3 account email — we'll send a one-time code",
    "email",
    "email",
    note("You need a Terminal 3 account to seal your documents. No account yet? ", " (with test credits) first, then use that email here."),
  );
export const askOtpCode = () =>
  ask(
    "Check your email",
    "Enter the code from the newest email we sent you",
    "text",
    "one-time-code",
    note(
      "If this email isn't a Terminal 3 account, the code won't let you seal: you'll be stopped before anything is sent. ",
      " with this email, then try again.",
    ),
  );
