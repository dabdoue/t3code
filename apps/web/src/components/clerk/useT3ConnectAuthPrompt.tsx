import { useClerk } from "@clerk/react";
import { useState } from "react";

import { isElectron } from "../../env";
import { ensureLocalApi } from "../../localApi";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { resolveClerkSignInProps, resolveClerkSignUpAction } from "./authRedirect";

export function useT3ConnectAuthPrompt() {
  const clerk = useClerk();
  const [accountPortalOpen, setAccountPortalOpen] = useState(false);
  const openAuthPrompt = () => {
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  };
  const openSignUpPrompt = () => {
    const action = resolveClerkSignUpAction(window.location.href, isElectron);
    if (action.type === "clerk") {
      clerk.openSignUp(action.props);
      return;
    }

    void (async () => {
      try {
        await ensureLocalApi().shell.openExternal(action.url);
        setAccountPortalOpen(true);
      } catch {
        toastManager.add({ type: "error", title: "Unable to open T3 Connect sign-up" });
      }
    })();
  };
  const authPrompt = (
    <AlertDialog open={accountPortalOpen} onOpenChange={setAccountPortalOpen}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Finish creating your T3 Connect account</AlertDialogTitle>
          <AlertDialogDescription>
            Complete sign-up in your browser, then return here and continue with sign in.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Not yet</AlertDialogClose>
          <AlertDialogClose render={<Button />} onClick={openAuthPrompt}>
            Continue with sign in
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
  return { authPrompt, openAuthPrompt, openSignUpPrompt };
}
