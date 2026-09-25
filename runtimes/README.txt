Put NVIDIA runtime DLLs here ONLY for your own machine:

    nvngx_dlssnr.dll     (DLSS 5 neural rendering)
    nvngx_dlss.dll       (super resolution)
    nvngx_dlssg.dll      (frame generation)

The installer looks here first, then in %LOCALAPPDATA%\RHI\Custom\Addons, then in games
that already have them.

Leave this folder empty in any copy you hand to someone else. These are NVIDIA's files,
there is no public SDK for the neural-rendering runtime, and redistributing them is not
yours to do.
