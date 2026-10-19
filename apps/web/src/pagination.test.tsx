// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { Pagination, usePage } from './components';

const items = Array.from({ length: 29 }, (_, index) => index + 1);

function PaginatedList({ values = items }: { values?: number[] }) {
  const visible = usePage(values);
  const location = useLocation();
  return (
    <>
      <ol>
        {visible.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ol>
      <Pagination total={values.length} />
      <output aria-label="Current query">{location.search}</output>
    </>
  );
}

function view(page: string, values = items) {
  return (
    <MemoryRouter initialEntries={[`/findings?repo=example%2Fproject&page=${page}`]}>
      <PaginatedList values={values} />
    </MemoryRouter>
  );
}

afterEach(cleanup);

describe('pagination query normalization', () => {
  it.each([
    ['1.5', 1],
    ['2.9', 2],
    ['invalid', 1],
    ['', 1],
    ['0', 1],
    ['-3', 1],
    ['Infinity', 1],
    ['-Infinity', 1],
    ['NaN', 1],
    ['1e309', 1],
    ['999999999999999999999999999', 3],
    ['100', 3],
    ['2', 2],
  ])('uses a bounded integer page for %s', (query, expectedPage) => {
    render(view(query));
    const start = (expectedPage - 1) * 12;
    const expectedItems = items.slice(start, start + 12);
    expect(screen.getAllByRole('listitem').map((item) => Number(item.textContent))).toEqual(
      expectedItems,
    );
    expect(screen.getByText(`Page ${expectedPage} of 3`)).toBeTruthy();
    expect(
      screen.getByText(`${start + 1}–${Math.min(start + 12, items.length)} of 29`),
    ).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Previous page' }).disabled).toBe(
      expectedPage === 1,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next page' }).disabled).toBe(
      expectedPage === 3,
    );
  });

  it('navigates between complete pages while preserving the repository filter', () => {
    render(view('1.5'));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((item) => Number(item.textContent))).toEqual(
      items.slice(12, 24),
    );
    expect(screen.getByRole('status', { name: 'Current query' }).textContent).toBe(
      '?repo=example%2Fproject&page=2',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((item) => Number(item.textContent))).toEqual(
      items.slice(0, 12),
    );
  });

  it.each([{ values: [] }, { values: [1, 2, 3] }])(
    'renders all available items without page controls for $values',
    ({ values }) => {
      render(view('100', values));
      expect(screen.queryAllByRole('listitem').map((item) => Number(item.textContent))).toEqual(
        values,
      );
      expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Previous page' })).toBeNull();
    },
  );
});
