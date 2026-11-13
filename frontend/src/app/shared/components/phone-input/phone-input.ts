import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import { SelectComponent, SelectOption, TextInputComponent } from 'nexprime';
import {
  CountryCode,
  Metadata,
  getCountries,
  getCountryCallingCode,
  parsePhoneNumberFromString,
} from 'libphonenumber-js/mobile';
import metadata from 'libphonenumber-js/metadata.mobile.json';
import { NpInputAttrs } from '../../forms/np-input-attrs';

export const DEFAULT_COUNTRY: CountryCode = 'IN';

const regionName = new Intl.DisplayNames(['en'], { type: 'region' });

const COUNTRY_OPTIONS: SelectOption[] = getCountries()
  .map((code) => ({
    value: code,
    label: `+${getCountryCallingCode(code)}`,
    description: regionName.of(code) ?? code,
    image: `https://flagcdn.com/w40/${code.toLowerCase()}.png`,
  }))
  .sort((a, b) =>
    a.value === DEFAULT_COUNTRY
      ? -1
      : b.value === DEFAULT_COUNTRY
        ? 1
        : a.description.localeCompare(b.description),
  );

interface Plan {
  possibleLengths(): number[];
  type(kind: 'MOBILE'): Plan | undefined;
}
const plans = new Metadata() as Metadata & { numberingPlan: Plan };

export function maxMobileDigits(country: CountryCode): number {
  plans.selectNumberingPlan(country);
  const plan = plans.numberingPlan;
  return Math.max(...(plan.type('MOBILE') ?? plan).possibleLengths());
}

function split(value: string, current: CountryCode): { country: CountryCode; national: string } {
  const parsed = value ? parsePhoneNumberFromString(value, DEFAULT_COUNTRY) : undefined;
  if (!parsed) return { country: current, national: value.replace(/\D/g, '') };
  const code = parsed.countryCallingCode;
  const sharing = (metadata.country_calling_codes as Record<string, CountryCode[]>)[code] ?? [];
  const country =
    getCountryCallingCode(current) === code ? current : (sharing[0] ?? DEFAULT_COUNTRY);
  return { country, national: String(parsed.nationalNumber) };
}

@Component({
  selector: 'bb-phone-input',
  imports: [SelectComponent, TextInputComponent, NpInputAttrs],
  templateUrl: './phone-input.html',
  styleUrl: './phone-input.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(focusout)': 'touch.emit()' },
})
export class PhoneInput implements FormValueControl<string> {
  readonly value = model('');
  readonly label = input('Phone number');
  readonly hint = input('');
  readonly error = input('');
  readonly required = input(false);
  readonly disabled = input(false);
  readonly touch = output<void>();

  protected readonly countries = COUNTRY_OPTIONS;
  protected readonly country = signal<CountryCode>(DEFAULT_COUNTRY);
  protected readonly national = signal('');
  protected readonly maxDigits = computed(() => maxMobileDigits(this.country()));
  protected readonly placeholder = computed(() =>
    this.country() === 'IN' ? 'Enter mobile number' : `${this.maxDigits()}-digit mobile number`,
  );
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly numberInput = viewChild.required(TextInputComponent);
  private emitted = '';

  constructor() {
    effect(() => {
      const value = this.value();
      if (value === this.emitted) return;
      untracked(() => {
        const { country, national } = split(value, this.country());
        this.country.set(country);
        this.national.set(national);
        this.emitted = value;
      });
    });
  }

  protected setCountry(country: string): void {
    this.country.set(country as CountryCode);
    this.setNational(this.national());
  }

  protected setNational(text: string): void {
    const pasted = text.trim().startsWith('+') ? split(text, this.country()) : null;
    if (pasted) this.country.set(pasted.country);
    const digits = (pasted?.national ?? text)
      .replace(/\D/g, '')
      .replace(/^0+/, '')
      .slice(0, this.maxDigits());
    this.national.set(digits);
    if (digits !== text) this.numberInput().value.set(digits);
    const box = this.host.nativeElement.querySelector<HTMLInputElement>('np-text-input input');
    if (box && box.value !== digits) box.value = digits;
    this.emitted = digits ? `+${getCountryCallingCode(this.country())}${digits}` : '';
    this.value.set(this.emitted);
  }
}
