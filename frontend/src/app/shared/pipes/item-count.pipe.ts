import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'itemCount' })
export class ItemCountPipe implements PipeTransform {
  transform(order: { items: { quantity: number }[] }): string {
    const count = order.items.reduce((sum, i) => sum + i.quantity, 0);
    return `${count} ${count === 1 ? 'item' : 'items'}`;
  }
}
