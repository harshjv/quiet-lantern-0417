import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'

export function SixDigitCode({ id, value, onChange, onComplete, autoFocus }: { id?: string; value: string; onChange: (value: string) => void; onComplete?: () => void; autoFocus?: boolean }) {
  return (
    <InputOTP
      id={id}
      maxLength={6}
      value={value}
      onChange={onChange}
      onComplete={onComplete}
      autoFocus={autoFocus}
      inputMode="numeric"
      pattern="^[0-9]+$"
      aria-label="Six-digit code"
      autoComplete="one-time-code"
    >
      <InputOTPGroup>
        {Array.from({ length: 6 }, (_, i) => (
          <InputOTPSlot key={i} index={i} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  )
}
