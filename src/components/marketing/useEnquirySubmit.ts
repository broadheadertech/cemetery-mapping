"use client";

/**
 * Shared submit plumbing for the two public marketing forms.
 *
 * Both forms use uncontrolled inputs with `name` attributes, so the
 * submit handler reads them straight off the form via `FormData`
 * rather than mirroring every field into React state. That keeps the
 * change to each form small and, more usefully, means a field can be
 * added to the markup and to the Convex validator without a third
 * place needing to agree.
 *
 * The failure path matters as much as the success path here. If the
 * mutation rejects, the visitor must NOT see a thank-you — that was
 * the original defect. They see what went wrong and the phone number.
 */

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";

import { translateError } from "@/lib/errors";

export type EnquiryKind = "visit" | "pricing";

type SubmitEnquiryArgs = {
  kind: EnquiryKind;
  name: string;
  contact: string;
  preferredDate?: string;
  preferredTime?: string;
  purpose?: string;
  lotTypeInterest?: string;
  timing?: string;
  notes?: string;
};

const submitEnquiryRef = makeFunctionReference<
  "mutation",
  SubmitEnquiryArgs,
  { enquiryId: string }
>("enquiries:submitEnquiry");

export type EnquiryState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

/** Read a named field off the form, trimmed. `undefined` when blank. */
function field(data: FormData, name: string): string | undefined {
  const raw = data.get(name);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function useEnquirySubmit(kind: EnquiryKind): {
  state: EnquiryState;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  reset: () => void;
} {
  const submitEnquiry = useMutation(submitEnquiryRef);
  const [state, setState] = useState<EnquiryState>({ kind: "idle" });

  const onSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>): void => {
      e.preventDefault();
      if (state.kind === "sending") return;

      const data = new FormData(e.currentTarget);
      const name = field(data, "name");
      // The visit form calls it `phone`; the pricing form calls it
      // `contact` ("phone or email"). Accept either.
      const contact = field(data, "contact") ?? field(data, "phone");

      if (name === undefined || contact === undefined) {
        // The inputs are `required`, so the browser normally catches
        // this first. Belt and braces — never show a thank-you for a
        // submission we cannot act on.
        setState({
          kind: "error",
          message:
            "Please give us your name and a way to reach you.",
        });
        return;
      }

      const args: SubmitEnquiryArgs = { kind, name, contact };
      const preferredDate = field(data, "day");
      if (preferredDate !== undefined) args.preferredDate = preferredDate;
      const preferredTime = field(data, "time");
      if (preferredTime !== undefined) args.preferredTime = preferredTime;
      const purpose = field(data, "purpose");
      if (purpose !== undefined) args.purpose = purpose;
      const lotType = field(data, "lotType");
      if (lotType !== undefined) args.lotTypeInterest = lotType;
      const timing = field(data, "timing");
      if (timing !== undefined) args.timing = timing;
      const notes = field(data, "notes");
      if (notes !== undefined) args.notes = notes;

      setState({ kind: "sending" });
      void submitEnquiry(args)
        .then(() => {
          setState({ kind: "sent" });
        })
        .catch((err: unknown) => {
          setState({ kind: "error", message: translateError(err).detail });
        });
    },
    [kind, state.kind, submitEnquiry],
  );

  const reset = useCallback((): void => {
    setState({ kind: "idle" });
  }, []);

  return { state, onSubmit, reset };
}
