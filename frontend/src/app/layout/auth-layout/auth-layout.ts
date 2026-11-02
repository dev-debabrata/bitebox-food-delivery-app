import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { BrandLogo } from '../../shared/components/brand-logo/brand-logo';

/** Split-screen layout for sign-in/registration. Brand panel collapses to a header on phones. */
@Component({
  selector: 'bb-auth-layout',
  imports: [RouterOutlet, RouterLink, MatIconModule, BrandLogo],
  templateUrl: './auth-layout.html',
  styleUrl: './auth-layout.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthLayout {
  protected readonly perks = [
    { icon: 'storefront', text: 'Hundreds of local kitchens in one place' },
    { icon: 'two_wheeler', text: 'Live tracking from kitchen to doorstep' },
    { icon: 'verified_user', text: 'Secure checkout with cash or online payment' },
  ];
  protected readonly year = new Date().getFullYear();
}
