import { computed, inject } from '@angular/core';
import { AuthService } from '../../core/auth/auth.service';

/** Where "Help & support" lives for the signed-in user: /support, /restaurant/support or /delivery/support. */
export function supportBase() {
  const auth = inject(AuthService);
  const role = computed(() => auth.role());
  return {
    isCustomer: computed(() => role() === 'customer'),
    path: computed(() =>
      role() === 'restaurant' ? '/restaurant/support' : role() === 'delivery' ? '/delivery/support' : '/support',
    ),
  };
}
