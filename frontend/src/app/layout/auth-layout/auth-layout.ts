import { NpIconPipe } from '../../shared/icons/np-icon-name';
import { IconComponent } from 'nexprime';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { BrandLogo } from '../../shared/components/brand-logo/brand-logo';

@Component({
  selector: 'bb-auth-layout',
  imports: [RouterOutlet, RouterLink, IconComponent, NpIconPipe, BrandLogo],
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
