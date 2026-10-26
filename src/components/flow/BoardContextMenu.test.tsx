// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useFactoryStore } from "@/store/factory-store";
import { readBoardViewSnapshot } from "./board-view";
import { BoardContextMenu } from "./BoardContextMenu";

afterEach(() => cleanup());

const target = { kind: "pane" as const, x: 10, y: 10, flow: { x: 300, y: 200 } };

describe("the empty-board menu", () => {
  it("offers the annotations and the background, and adds a box where it was opened", () => {
    useFactoryStore.setState((s) => ({
      project: { ...s.project, annotations: [] },
    }));
    const onClose = vi.fn();
    render(<BoardContextMenu target={target} onClose={onClose} />);
    for (const label of ["Add sticky note", "Add box", "Add arrow", "Background"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    fireEvent.click(screen.getByText("Add box"));
    const box = useFactoryStore.getState().project.annotations?.at(-1);
    expect(box).toMatchObject({ kind: "box", position: { x: 300, y: 200 } });
    expect(onClose).toHaveBeenCalled();
  });

  it("Background lists the papers and the patterns and sets the board's view", () => {
    render(<BoardContextMenu target={target} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Background"));
    fireEvent.click(screen.getByText("Blueprint"));
    expect(readBoardViewSnapshot().canvasTheme).toBe("blueprint");
  });
});
