import React from 'react';
import { render, screen } from '@testing-library/react';
import AppErrorBoundary from './AppErrorBoundary';

function Broken() { throw new Error('Synthetic render failure'); }

it('shows its children while they render', () => {
  render(<AppErrorBoundary><p>Planner</p></AppErrorBoundary>);
  expect(screen.getByText('Planner')).toBeInTheDocument();
});

it('says to reload instead of leaving a blank page when anything inside fails to render', () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
  expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong. Reload the page.');
  console.error.mockRestore();
});
