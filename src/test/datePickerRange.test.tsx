import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { addDays, format } from 'date-fns';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
import DatePickerField from '@/components/task-detail/fields/DatePickerField';

describe('a start date cannot be after the due date', () => {
  it('offers only quick picks on or before the due date', () => {
    const change = vi.fn();
    const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
    render(<DatePickerField value={undefined} onChange={change} mode="start" maxDate={tomorrow} />);
    fireEvent.click(screen.getByRole('button', { name: /taskCreate.selectDate/ }));
    expect(screen.getByRole('button', { name: 'datePicker.today' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'datePicker.twoWeeks' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'datePicker.twoWeeks' }));
    expect(change).not.toHaveBeenCalled();
  });
});
