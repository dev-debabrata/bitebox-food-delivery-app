import { Pipe, PipeTransform } from '@angular/core';

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const inrPaise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined || Number.isNaN(paise)) return '';
  const rupees = paise / 100;
  return Number.isInteger(rupees) ? inrWhole.format(rupees) : inrPaise.format(rupees);
}

export const rupeesToPaise = (rupees: number): number => Math.round(rupees * 100);

@Pipe({ name: 'inr' })
export class InrPipe implements PipeTransform {
  transform(paise: number | null | undefined): string {
    return formatPaise(paise);
  }
}

export function formatDistance(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return '';
  return meters < 1000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1000).toFixed(1)} km`;
}

@Pipe({ name: 'distance' })
export class DistancePipe implements PipeTransform {
  transform(meters: number | null | undefined): string {
    return formatDistance(meters);
  }
}
