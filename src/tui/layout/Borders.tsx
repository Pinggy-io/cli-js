import React from "react";
import { Box } from "ink";

export const Borders = ({ children }: { children: React.ReactNode }) => (
	<Box
		borderStyle="round"
		borderColor="green"
		padding={1}
		flexDirection="column"
		width="100%"
		alignItems="center"
	>
		{children}
	</Box>
);
