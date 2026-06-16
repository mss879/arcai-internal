import * as React from "react";

/** Render text with @mentions highlighted. */
export function MentionText({ text }: { text: string }) {
  const parts = text.split(/(@[a-zA-Z0-9._-]+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^@[a-zA-Z0-9._-]+$/.test(part) ? (
          <span key={i} className="mention">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}
