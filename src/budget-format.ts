const numbers = new Intl.NumberFormat("zh-TW");

export function formatBudgetAmount(scaled: bigint) {
  const magnitude = scaled < 0n ? -scaled : scaled;
  const whole = numbers.format(magnitude / 10_000n);
  const fraction = String(magnitude % 10_000n).padStart(4, "0").replace(/0+$/, "");
  return `${scaled < 0n ? "−" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
