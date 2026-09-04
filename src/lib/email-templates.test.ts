import { describe, expect, it } from "vitest";

import {
  firstNameOf,
  renderEmailTemplate,
  tokensUsed,
} from "./email-templates";

describe("renderEmailTemplate", () => {
  it("fills the subject and body from one set of values", () => {
    const out = renderEmailTemplate(
      {
        subject: "Your quote {{quote_number}}",
        body: "Hi {{name}},\nHere is {{quote_number}} for {{amount}}.",
      },
      { name: "Nimal", quote_number: "Q-0007", amount: "LKR 250,000" },
    );
    expect(out.subject).toBe("Your quote Q-0007");
    expect(out.body).toBe("Hi Nimal,\nHere is Q-0007 for LKR 250,000.");
  });

  it("blanks a token it has no value for — a client must never see braces", () => {
    const out = renderEmailTemplate(
      { subject: "Hi {{name}}", body: "About {{project}}." },
      { name: "Nimal" },
    );
    expect(out.body).toBe("About .");
  });

  it("accepts tokens beyond the known list", () => {
    const out = renderEmailTemplate(
      { subject: "{{custom_thing}}", body: "x" },
      { custom_thing: "Anything" },
    );
    expect(out.subject).toBe("Anything");
  });

  it("trims the subject but leaves the body's shape alone", () => {
    const out = renderEmailTemplate(
      { subject: "  {{name}}  ", body: "  spaced  " },
      { name: "Nimal" },
    );
    expect(out.subject).toBe("Nimal");
    expect(out.body).toBe("  spaced  ");
  });
});

describe("tokensUsed", () => {
  it("lists each token once, from both subject and body", () => {
    expect(
      tokensUsed({ subject: "{{name}} and {{amount}}", body: "{{name}} again" }).sort(),
    ).toEqual(["amount", "name"]);
  });

  it("tolerates whitespace and case inside the braces", () => {
    expect(tokensUsed({ subject: "{{ Name }}", body: "" })).toEqual(["name"]);
  });

  it("finds nothing in a template with no tokens", () => {
    expect(tokensUsed({ subject: "Hello", body: "No tokens here" })).toEqual([]);
  });
});

describe("firstNameOf", () => {
  it("takes the first word", () => {
    expect(firstNameOf("Nimal Perera")).toBe("Nimal");
  });

  it("stays blank rather than inventing a greeting", () => {
    expect(firstNameOf(null)).toBe("");
    expect(firstNameOf("   ")).toBe("");
  });
});
